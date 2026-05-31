const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 5000;

// ===== FIREBASE INIT =====
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log("✅ Firebase connected");
} catch (err) {
  console.error("❌ Firebase Error:", err.message);
  // Server chalne do, baad mein fix karenge
}

const db = admin.firestore ? admin.firestore() : null;

// ===== CONFIG =====
const TRANZUPI_TOKEN = process.env.TRANZUPI_USER_TOKEN;
const TRANZUPI_MOBILE = process.env.TRANZUPI_MOBILE || '9999999999';

// ===== HEALTH CHECK (Render ke liye MUST) =====
app.get('/', (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// ===== AUTH MIDDLEWARE =====
const authMiddleware = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split('Bearer ')[1];
    if (!token) return res.status(401).json({ error: 'No token' });
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch (e) {
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ===== CREATE ORDER =====
app.post('/api/wallet/createOrder', authMiddleware, async (req, res) => {
  try {
    const { amount, orderId, userId } = req.body;
    
    if (!amount || !orderId || !userId) {
      return res.status(400).json({ error: 'Missing fields' });
    }

    // TranzUPI call
    const payload = new URLSearchParams();
    payload.append('customer_mobile', TRANZUPI_MOBILE);
    payload.append('user_token', TRANZUPI_TOKEN);
    payload.append('amount', parseFloat(amount).toFixed(2));
    payload.append('order_id', orderId);
    payload.append('redirect_url', 'https://purnima-esport.web.app');
    payload.append('remark1', 'Wallet Recharge');

    const response = await axios.post('https://tranzupi.com/api/create-order', payload, {
      headers: { 
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0'
      },
      timeout: 10000
    });

    const data = response.data;
    
    if (data.status === true || data.success === true) {
      const result = data.result || data;
      
      // Save to Firestore
      if (db) {
        await db.collection('orders').doc(orderId).set({
          orderId, userId, amount: parseFloat(amount),
          status: 'PENDING',
          createdAt: admin.firestore.FieldValue.serverTimestamp()
        });
      }

      return res.json({
        success: true,
        qrData: result.payment_url,
        orderId,
        upiId: result.upi_id || 'payment@tranzupi'
      });
    }

    return res.status(400).json({ error: data.message || 'Failed' });

  } catch (err) {
    console.error('Create Order Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== VERIFY ORDER =====
app.post('/api/wallet/verifyOrder', authMiddleware, async (req, res) => {
  try {
    const { orderId } = req.body;
    
    // Check Firestore
    let orderData = null;
    if (db) {
      const doc = await db.collection('orders').doc(orderId).get();
      if (doc.exists) orderData = doc.data();
    }

    // Verify with TranzUPI
    const payload = new URLSearchParams();
    payload.append('user_token', TRANZUPI_TOKEN);
    payload.append('order_id', orderId);

    const response = await axios.post('https://tranzupi.com/api/check-order-status', payload, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000
    });

    const result = response.data.result || response.data;
    const isPaid = response.data.status === 'COMPLETED' && 
                   (result.status === 'SUCCESS' || result.txnStatus === 'COMPLETED');

    if (isPaid && orderData && orderData.status !== 'PAID') {
      // Credit wallet
      const userRef = db.collection('users').doc(orderData.userId);
      await db.runTransaction(async (t) => {
        const userDoc = await t.get(userRef);
        const newBal = (userDoc.data().balance || 0) + orderData.amount;
        
        t.update(userRef, {
          balance: newBal,
          transactions: admin.firestore.FieldValue.arrayUnion({
            type: 'credit', amount: orderData.amount,
            msg: `Recharge ${orderId}`, date: Date.now()
          })
        });
        t.update(db.collection('orders').doc(orderId), { status: 'PAID' });
      });
    }

    res.json({ status: isPaid ? 'PAID' : 'PENDING' });

  } catch (err) {
    console.error('Verify Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== WEBHOOK (CRITICAL - Plain Text 200) =====
app.post('/api/wallet/webhook', async (req, res) => {
  console.log('Webhook received:', req.body);
  
  const { order_id, status } = req.body;

  // ALWAYS return 200 OK first (TranzUPI ko retry नहीं करने देना)
  res.set('Content-Type', 'text/plain');
  res.status(200).send('OK');

  // Background mein process karo
  try {
    if (!order_id || !db) return;

    const orderDoc = await db.collection('orders').doc(order_id).get();
    if (!orderDoc.exists) return;

    const orderData = orderDoc.data();
    if (orderData.status === 'PAID') return;

    // Re-verify
    const payload = new URLSearchParams();
    payload.append('user_token', TRANZUPI_TOKEN);
    payload.append('order_id', order_id);

    const verifyRes = await axios.post('https://tranzupi.com/api/check-order-status', payload, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000
    });

    const result = verifyRes.data.result || verifyRes.data;
    const isPaid = verifyRes.data.status === 'COMPLETED' && 
                   (result.status === 'SUCCESS');

    if (isPaid) {
      const userRef = db.collection('users').doc(orderData.userId);
      await db.runTransaction(async (t) => {
        const userDoc = await t.get(userRef);
        const newBal = (userDoc.data().balance || 0) + orderData.amount;
        
        t.update(userRef, {
          balance: newBal,
          transactions: admin.firestore.FieldValue.arrayUnion({
            type: 'credit', amount: orderData.amount,
            msg: `Webhook Recharge ${order_id}`, date: Date.now()
          })
        });
        t.update(db.collection('orders').doc(order_id), { status: 'PAID' });
      });
      console.log('Webhook processed successfully for', order_id);
    }

  } catch (err) {
    console.error('Webhook processing error:', err.message);
    // Error ke baad bhi humne pehle hi 200 bhej diya tha
  }
});

// ===== ERROR HANDLER =====
app.use((err, req, res, next) => {
  console.error('Express Error:', err);
  res.status(500).json({ error: 'Internal error' });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
