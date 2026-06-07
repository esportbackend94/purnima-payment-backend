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
// ============================================
// FIREBASE ADMIN INITIALIZE (FIXED)
// ============================================
try {
  const serviceAccountRaw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  
  if (!serviceAccountRaw) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT_JSON environment variable is missing!');
  }
  
  console.log('Service Account Raw Length:', serviceAccountRaw.length);
  console.log('First 100 chars:', serviceAccountRaw.substring(0, 100));
  
  let serviceAccount;
  try {
    serviceAccount = JSON.parse(serviceAccountRaw);
  } catch (parseErr) {
    console.error('JSON Parse Error:', parseErr.message);
    throw new Error('Invalid JSON in FIREBASE_SERVICE_ACCOUNT_JSON. Make sure it is raw JSON string, not base64 or file path.');
  }
  
  console.log('Service Account Email:', serviceAccount.client_email);
  console.log('Project ID:', serviceAccount.project_id);
  
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: serviceAccount.project_id || "purnima-esport-d9b94"
  });
  
  console.log('✅ Firebase Admin initialized successfully');
  
} catch (initErr) {
  console.error('❌ Firebase Admin Init Failed:', initErr.message);
  throw initErr;
}

const db = admin.firestore();
db.settings({ 
  ignoreUndefinedProperties: true 
});

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
  
  // 🔥 DEBUG: Token length check
  if (!token || token.length < 100) {
    throw new Error('Unauthorized - Invalid token format');
  }
  
  try {
    return await admin.auth().verifyIdToken(token);
  } catch (err) {
    console.error('Token verify failed:', err.message);
    throw new Error('Unauthorized - Token expired or invalid');
  }
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

        // Firestore mein pending order save karo (Doc ID ko Lowercase kiya)
    try {
      console.log('Creating pending order:', orderId.toLowerCase(), 'for user:', uid);
      
      await db.collection('pending_orders').doc(orderId.toLowerCase()).set({
        orderId:   orderId,
        userId:    uid,
        amount:    parseFloat(amount),
        status:    'PENDING',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });
      
      console.log('✅ Pending order saved successfully');
      
    } catch (dbErr) {
      console.error('❌ Firestore Write Error:', dbErr.message);
      console.error('Error Code:', dbErr.code);
      throw new Error('Database permission denied. Check Firebase Service Account has Admin role.');
    }


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
// POST /api/wallet/verifyOrder
// ============================================
app.post('/api/wallet/verifyOrder', async (req, res) => {
  try {
    await verifyFirebaseToken(req);

    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: 'Order ID required' });

    // Pehle local database check karo (Using lowercase doc ID)
    const orderDoc = await db.collection('pending_orders').doc(orderId.toLowerCase()).get();
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
      (tranzData.result.txnStatus === 'SUCCESS' || 
       tranzData.result.txnStatus === 'COMPLETED' || 
       tranzData.result.status === 'SUCCESS' || 
       tranzData.result.status === 'COMPLETED');

    if (isPaid) {
      const orderData = orderDoc.exists ? orderDoc.data() : null;
      
      if (orderData && orderData.status !== 'PAID') {
        const userId = orderData.userId;
        const amount = orderData.amount;
        const utr = tranzData.result.utr || '';

        // 1. Order status ko PAID mark karo (Using lowercase doc ID)
        await db.collection('pending_orders').doc(orderId.toLowerCase()).set(
          { status: 'PAID', paidAt: admin.firestore.FieldValue.serverTimestamp(), utr: utr },
          { merge: true }
        );

        // 2. User wallet balance credit karo
        if (userId) {
          const userRef = db.collection('users').doc(userId);
          await userRef.update({
            balance: admin.firestore.FieldValue.increment(parseFloat(amount)),
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
      return res.json({ status: 'PAID' });
    }

    res.json({ status: 'PENDING' });

  } catch (err) {
    console.error('verifyOrder Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ============================================
// POST /api/webhook/tranzupi
// ============================================
app.post('/api/webhook/tranzupi', async (req, res) => {
  try {
    const { order_id, amount, remark2: userId, utr, status } = req.body;

    if (!order_id || !amount) return res.status(200).send('OK');

    // Idempotency check - Doc ID ko lowercase karke match kiya
    const orderDoc = await db.collection('pending_orders').doc(order_id.toLowerCase()).get();
    if (orderDoc.exists && orderDoc.data().status === 'PAID') {
      return res.status(200).send('OK');
    }

    if (status === 'SUCCESS' || status === 'COMPLETED') {
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
        (verifyData.result.txnStatus === 'SUCCESS' || 
         verifyData.result.txnStatus === 'COMPLETED' || 
         verifyData.result.status === 'SUCCESS' || 
         verifyData.result.status === 'COMPLETED');

      if (isVerified) {
        const originalAmount = (orderDoc.exists && orderDoc.data().amount) 
          ? parseFloat(orderDoc.data().amount) 
          : parseFloat(amount);

        // Order status ko PAID mark karo (Using lowercase doc ID)
        await db.collection('pending_orders').doc(order_id.toLowerCase()).set(
          { status: 'PAID', utr: utr || '', paidAt: admin.firestore.FieldValue.serverTimestamp() },
          { merge: true }
        );

        // User balance credit karo
        if (userId) {
          const userRef = db.collection('users').doc(userId);
          await userRef.update({ 
            balance: admin.firestore.FieldValue.increment(originalAmount),
            transactions: admin.firestore.FieldValue.arrayUnion({
              type: 'credit',
              amount: originalAmount,
              msg: 'Add Cash (Webhook)',
              date: Date.now(),
              utr: utr || '',
              orderId: order_id
            })
          });
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
