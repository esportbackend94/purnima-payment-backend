const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json());

// ==================== FIREBASE SETUP ====================
const serviceAccount = {
  // ... aapka existing service account ...
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// ==================== TRANZUPI CONFIG ====================
const TRANZUPI_USER_TOKEN = "766f3a89f4b64a5635e4f3c847c5d5fa";
const TRANZUPI_MOBILE = "9928492158";

// ==================== HELPER: Retry Logic for 503 ====================
async function callTranzUPIWithRetry(url, formData, maxRetries = 3) {
  let lastError;
  
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = await axios.post(url, formData.toString(), {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 15000
      });
      
      // Agar 503 aaya toh retry karo
      if (response.status === 503) {
        console.log(`Attempt ${i + 1}: TranzUPI returned 503, retrying...`);
        await new Promise(r => setTimeout(r, 2000 * (i + 1))); // Exponential backoff
        continue;
      }
      
      return response;
    } catch (err) {
      lastError = err;
      
      // 503 ya network error ho toh retry
      if (err.response?.status === 503 || err.code === 'ECONNREFUSED' || err.code === 'ETIMEDOUT') {
        console.log(`Attempt ${i + 1}: Error ${err.response?.status || err.code}, retrying...`);
        await new Promise(r => setTimeout(r, 2000 * (i + 1)));
        continue;
      }
      
      // Baaki errors ke liye throw karo
      throw err;
    }
  }
  
  throw lastError;
}

// ==================== MIDDLEWARE ====================
async function verifyToken(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ error: 'No token provided' });
    }
    const token = authHeader.split('Bearer ')[1];
    const decoded = await admin.auth().verifyIdToken(token);
    req.uid = decoded.uid;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'Invalid token: ' + err.message });
  }
}

// ==================== ROUTES ====================

// Test Route
app.get('/', (req, res) => {
  res.json({ message: 'Purnima Backend Running!', status: 'OK' });
});

// Create Order (with better error handling)
app.post('/api/wallet/createOrder', verifyToken, async (req, res) => {
  try {
    const { amount, orderId, userName } = req.body;
    const uid = req.uid;

    if (!amount || amount < 10) {
      return res.status(400).json({ error: 'Minimum amount Rs.10' });
    }

    const formattedAmount = parseFloat(amount).toFixed(2);

    const formData = new URLSearchParams();
    formData.append('user_token', TRANZUPI_USER_TOKEN);
    formData.append('customer_mobile', TRANZUPI_MOBILE);
    formData.append('amount', formattedAmount);
    formData.append('order_id', orderId);
    formData.append('redirect_url', 'https://purnima-esport.web.app');
    formData.append('remark1', 'Wallet Recharge');
    formData.append('remark2', userName || 'User');

    // 🔥 RETRY LOGIC LAGAO 🔥
    let response;
    try {
      response = await callTranzUPIWithRetry(
        'https://tranzupi.com/api/create-order',
        formData,
        3 // 3 retries
      );
    } catch (err) {
      // TranzUPI completely down hai
      console.error('TranzUPI completely down:', err.message);
      return res.status(503).json({
        error: 'Payment gateway temporarily unavailable. Please try again after 2-3 minutes.',
        detail: 'TranzUPI server is down or overloaded',
        retryAfter: 120 // seconds
      });
    }

    const data = response.data;

    if (data.status === false || data.status === 'false') {
      return res.status(500).json({
        error: data.message || 'TranzUPI payment failed',
        detail: data
      });
    }

    // Order save karo
    await db.collection('pending_orders').doc(orderId).set({
      uid: uid,
      amount: amount,
      orderId: orderId,
      status: 'PENDING',
      createdAt: Date.now()
    });

    const paymentUrl = data.result?.payment_url || data.payment_url || data.data?.payment_url;

    return res.json({
      success: true,
      orderId: orderId,
      paymentUrl: paymentUrl,
      qrData: paymentUrl,
      upiId: 'Pay via Link'
    });

  } catch (err) {
    console.log('CreateOrder Error:', err.message);
    return res.status(500).json({
      error: err.message,
      detail: err.response ? err.response.data : null
    });
  }
});

// Verify Order
app.post('/api/wallet/verifyOrder', verifyToken, async (req, res) => {
  try {
    const { orderId } = req.body;
    const uid = req.uid;

    const orderDoc = await db.collection('pending_orders').doc(orderId).get();
    if (!orderDoc.exists) {
      return res.json({ status: 'NOT_FOUND' });
    }

    const orderData = orderDoc.data();
    if (orderData.status === 'PAID') {
      return res.json({ status: 'PAID' });
    }

    const formData = new URLSearchParams();
    formData.append('user_token', TRANZUPI_USER_TOKEN);
    formData.append('order_id', orderId);

    const response = await axios.post(
      'https://tranzupi.com/api/check-order-status',
      formData.toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000
      }
    );

    const data = response.data;
    const payStatus = data.status || data.result?.status || '';

    if (payStatus === 'COMPLETED' || payStatus === 'completed' || payStatus === 'SUCCESS' || payStatus === 'PAID') {
      await db.collection('users').doc(uid).update({
        balance: admin.firestore.FieldValue.increment(orderData.amount),
        transactions: admin.firestore.FieldValue.arrayUnion({
          type: 'credit',
          amount: orderData.amount,
          msg: 'Wallet Recharge: Rs.' + orderData.amount,
          date: Date.now()
        })
      });

      await db.collection('pending_orders').doc(orderId).update({
        status: 'PAID',
        paidAt: Date.now()
      });

      return res.json({ status: 'PAID' });
    }

    return res.json({ status: 'PENDING', raw: data });

  } catch (err) {
    console.log('VerifyOrder Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// Webhook
app.post('/api/webhook', async (req, res) => {
  try {
    const body = req.body;
    console.log('Webhook received:', body);

    const orderId = body.order_id || body.orderId;
    const status = body.status;

    if (status === 'COMPLETED' || status === 'completed' || status === 'PAID' || status === 'SUCCESS') {
      const orderDoc = await db.collection('pending_orders').doc(orderId).get();
      if (orderDoc.exists) {
        const orderData = orderDoc.data();
        if (orderData.status !== 'PAID') {
          await db.collection('users').doc(orderData.uid).update({
            balance: admin.firestore.FieldValue.increment(orderData.amount),
            transactions: admin.firestore.FieldValue.arrayUnion({
              type: 'credit',
              amount: orderData.amount,
              msg: 'Wallet Recharge: Rs.' + orderData.amount,
              date: Date.now()
            })
          });
          await db.collection('pending_orders').doc(orderId).update({
            status: 'PAID',
            paidAt: Date.now()
          });
        }
      }
    }

    res.json({ success: true });
  } catch (err) {
    console.log('Webhook Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ==================== START SERVER ====================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server started on port ' + PORT);
});
