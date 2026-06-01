require('dotenv').config();
const express = require('express');
const cors = require('cors');
const admin = require('firebase-admin');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// FIREBASE ADMIN INITIALIZE
// ============================================
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// ============================================
// MIDDLEWARE
// ============================================
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================
// CONFIG (Render Environment Variables se)
// ============================================
const TRANZ_USER_TOKEN = process.env.TRANZ_USER_TOKEN;
const TRANZ_BASE_URL   = 'https://tranzupi.com';
const APP_URL          = process.env.APP_URL || 'https://your-app-url.com';
const MERCHANT_UPI     = process.env.MERCHANT_UPI || '';

// ============================================
// HELPER: Firebase Token Verify
// ============================================
async function verifyFirebaseToken(req) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    throw new Error('Unauthorized - Token missing');
  }
  const token = authHeader.split('Bearer ')[1];
  return await admin.auth().verifyIdToken(token);
}

// ============================================
// HEALTH CHECK
// ============================================
app.get('/', (req, res) => {
  res.json({ status: 'OK', message: 'Purnima E-Sports Backend Running' });
});

// ============================================
// POST /api/wallet/createOrder
// ============================================
app.post('/api/wallet/createOrder', async (req, res) => {
  try {
    const decodedToken = await verifyFirebaseToken(req);
    const uid = decodedToken.uid;

    const { amount, orderId, userName } = req.body;

    if (!amount || amount < 1)     return res.status(400).json({ error: 'Minimum ₹1 required' });
    if (amount > 50000)            return res.status(400).json({ error: 'Maximum ₹50,000 allowed' });
    if (!orderId)                  return res.status(400).json({ error: 'Order ID required' });

    // Firestore mein pending order save karo
    await db.collection('pending_orders').doc(orderId).set({
      orderId,
      userId:    uid,
      amount:    parseFloat(amount),
      status:    'PENDING',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    // TranzUPI API Call - Create Order
    const params = new URLSearchParams();
    params.append('user_token',      TRANZ_USER_TOKEN);
    params.append('customer_mobile', '9999999999');
    params.append('amount',          amount.toString());
    params.append('order_id',        orderId);
    params.append('redirect_url',    `${APP_URL}?payment=return`);
    params.append('remark1',         userName || 'Purnima User');
    params.append('remark2',         uid);

    const tranzRes = await fetch(`${TRANZ_BASE_URL}/api/create-order`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    params.toString()
    });

    const tranzData = await tranzRes.json();

    if (!tranzData.status || !tranzData.result || !tranzData.result.payment_url) {
      console.error('TranzUPI Error:', tranzData);
      return res.status(500).json({ error: tranzData.message || 'Gateway error' });
    }

    res.json({
      qrData:  tranzData.result.payment_url,
      orderId: orderId,
      upiId:   MERCHANT_UPI
    });

  } catch (err) {
    console.error('createOrder Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// POST /api/wallet/verifyOrder (UPDATED WITH WALLET CREDIT & IDEMPOTENCY)
// ============================================
app.post('/api/wallet/verifyOrder', async (req, res) => {
  try {
    await verifyFirebaseToken(req);

    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: 'Order ID required' });

    // Pehle local database check karo
    const orderDoc = await db.collection('pending_orders').doc(orderId).get();
    if (orderDoc.exists && orderDoc.data().status === 'PAID') {
      return res.json({ status: 'PAID' });
    }

    // TranzUPI API Call - Check Status
    const params = new URLSearchParams();
    params.append('user_token', TRANZ_USER_TOKEN);
    params.append('order_id',   orderId);

    const tranzRes = await fetch(`${TRANZ_BASE_URL}/api/check-order-status`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    params.toString()
    });

    const tranzData = await tranzRes.json();

    const isPaid =
      tranzData.status === 'COMPLETED' &&
      tranzData.result &&
      tranzData.result.txnStatus === 'SUCCESS';

    if (isPaid) {
      const orderData = orderDoc.exists ? orderDoc.data() : null;
      
      // Agar status abhi tak PAID nahi hai, to credit karo (duplicate credit hone se bachane ke liye)
      if (orderData && orderData.status !== 'PAID') {
        const userId = orderData.userId;
        const amount = orderData.amount;
        const utr = tranzData.result.utr || '';

        // 1. Order status ko PAID mark karo
        await db.collection('pending_orders').doc(orderId).set(
          { status: 'PAID', paidAt: admin.firestore.FieldValue.serverTimestamp(), utr: utr },
          { merge: true }
        );

        // 2. User wallet balance credit karo
        if (userId) {
          const userRef = db.collection('users').doc(userId);
          const userDoc = await userRef.get();
          if (userDoc.exists) {
            const currentBalance = userDoc.data().balance || 0;
            const newBalance = currentBalance + parseFloat(amount);

            // balance update aur transactions list mein green history jodna
            await userRef.update({
              balance: newBalance,
              transactions: admin.firestore.FieldValue.arrayUnion({
                type: 'credit',
                amount: parseFloat(amount),
                msg: 'Add Cash (Verified)',
                date: Date.now(),
                utr: utr,
                orderId: orderId
              })
            });
          }
        }
      }
      return res.json({ status: 'PAID' });
    }

    res.json({ status: 'PENDING' });

  } catch (err) {
    console.error('verifyOrder Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// POST /api/webhook/tranzupi (UPDATED WEBHOOK LOGIC)
// ============================================
app.post('/api/webhook/tranzupi', async (req, res) => {
  try {
    const { order_id, amount, remark2: userId, utr, status } = req.body;

    if (!order_id || !amount) return res.status(200).send('OK');

    // Idempotency check - ek order ek baar hi process ho
    const orderDoc = await db.collection('pending_orders').doc(order_id).get();
    if (orderDoc.exists && orderDoc.data().status === 'PAID') {
      return res.status(200).send('OK');
    }

    if (status === 'SUCCESS') {
      const params = new URLSearchParams();
      params.append('user_token', TRANZ_USER_TOKEN);
      params.append('order_id',   order_id);

      const verifyRes  = await fetch(`${TRANZ_BASE_URL}/api/check-order-status`, {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });
      const verifyData = await verifyRes.json();

      const isVerified =
        verifyData.status === 'COMPLETED' &&
        verifyData.result &&
        verifyData.result.txnStatus === 'SUCCESS';

      if (isVerified) {
        // Order status ko PAID mark karo
        await db.collection('pending_orders').doc(order_id).set(
          { status: 'PAID', utr: utr || '', paidAt: admin.firestore.FieldValue.serverTimestamp() },
          { merge: true }
        );

        // User balance credit karo
        if (userId) {
          const userRef = db.collection('users').doc(userId);
          const userDoc = await userRef.get();
          if (userDoc.exists) {
            const currentBalance = userDoc.data().balance || 0;
            const newBalance = currentBalance + parseFloat(amount);
            
            await userRef.update({ 
              balance: newBalance,
              transactions: admin.firestore.FieldValue.arrayUnion({
                type: 'credit',
                amount: parseFloat(amount),
                msg: 'Add Cash (Webhook)',
                date: Date.now(),
                utr: utr || '',
                orderId: order_id
              })
            });
          }
        }
      }
    }

    res.status(200).send('OK');

  } catch (err) {
    console.error('Webhook Error:', err.message);
    res.status(200).send('OK');
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
});
