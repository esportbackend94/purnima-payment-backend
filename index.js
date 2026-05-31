const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();
const admin = require('firebase-admin');

const app = express();

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
  credentials: false
}));
app.options('*', cors());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 5000;

// ===== FIREBASE ADMIN INIT =====
const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!serviceAccountJson) {
  console.error("CRITICAL: FIREBASE_SERVICE_ACCOUNT env var missing!");
  process.exit(1);
}

try {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(serviceAccountJson))
  });
  console.log("Firebase Admin connected successfully");
} catch (err) {
  console.error("Firebase init failed:", err.message);
  process.exit(1);
}

const db = admin.firestore();

// ===== CONFIG (Render env vars se match karta hai) =====
const TRANZUPI_TOKEN = process.env.TRANZUPI_USER_TOKEN;
const TRANZUPI_BASE_URL = process.env.TRANZUPI_BASE_URL || 'https://tranzupi.com';
const DEFAULT_CUSTOMER_MOBILE = process.env.CUSTOMER_MOBILE || '9999999999';

if (!TRANZUPI_TOKEN) {
  console.error("WARNING: TRANZUPI_USER_TOKEN env var missing! Payment will not work.");
}

console.log("TranzUPI Base URL:", TRANZUPI_BASE_URL);
console.log("TranzUPI Token configured:", TRANZUPI_TOKEN ? "YES" : "NO");

// ===== HELPER: TranzUPI API Call =====
async function callTranzUPI(endpoint, params) {
  const payload = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      payload.append(key, String(value));
    }
  }

  const url = `${TRANZUPI_BASE_URL}${endpoint}`;
  console.log(`TranzUPI Request -> ${url}`);
  console.log('Params:', Object.fromEntries(payload));

  try {
    const response = await axios.post(url, payload, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*'
      },
      timeout: 15000
    });

    console.log(`TranzUPI Response (${endpoint}):`, JSON.stringify(response.data, null, 2));
    return response.data;

  } catch (error) {
    console.error(`TranzUPI Error (${endpoint}):`, error.message);
    if (error.response) {
      console.error('HTTP Status:', error.response.status);
      console.error('Response:', error.response.data);
    }
    throw error;
  }
}

// ===== AUTH MIDDLEWARE =====
const authenticateUser = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized: Missing Bearer token' });
    }
    const idToken = authHeader.split('Bearer ')[1];
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('Auth failed:', error.message);
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
};

// ===== ROUTES =====

app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    time: new Date().toISOString(),
    firebase: 'connected',
    tranzupi_token: TRANZUPI_TOKEN ? 'configured' : 'MISSING',
    tranzupi_url: TRANZUPI_BASE_URL
  });
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// ===== CREATE ORDER =====
app.post('/api/wallet/createOrder', authenticateUser, async (req, res) => {
  try {
    console.log('CreateOrder -> User:', req.user.uid);
    console.log('CreateOrder -> Body:', req.body);

    const { amount, orderId, userId, userEmail, userName, customerMobile } = req.body;

    if (!amount || !orderId || !userId) {
      return res.status(400).json({ error: 'Missing: amount, orderId, userId' });
    }

    if (req.user.uid !== userId) {
      return res.status(403).json({ error: 'Forbidden: UID mismatch' });
    }

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // Customer mobile: frontend se bhejo, warna CUSTOMER_MOBILE env var use hoga
    const mobile = customerMobile
      ? String(customerMobile).replace(/\D/g, '')
      : DEFAULT_CUSTOMER_MOBILE;

    const tranzParams = {
      customer_mobile: mobile,
      user_token: TRANZUPI_TOKEN,
      amount: parsedAmount.toFixed(2),
      order_id: orderId,
      redirect_url: process.env.REDIRECT_URL || 'https://purnima-esport.web.app',
      remark1: 'Wallet Recharge',
      remark2: userName || userEmail || 'Gamer'
    };

    const tranzResponse = await callTranzUPI('/api/create-order', tranzParams);

    const isSuccess = tranzResponse.status === true || tranzResponse.status === 'success';

    if (!isSuccess) {
      console.error('TranzUPI create-order failed:', JSON.stringify(tranzResponse));
      return res.status(400).json({
        error: tranzResponse.message || 'TranzUPI order creation failed',
        tranzupiResponse: tranzResponse
      });
    }

    const result = tranzResponse.result || tranzResponse.data || {};
    const paymentUrl = result.payment_url || result.paymentUrl;

    if (!paymentUrl) {
      return res.status(500).json({
        error: 'Payment URL nahi mila TranzUPI se',
        tranzupiResponse: tranzResponse
      });
    }

    await db.collection('orders').doc(orderId).set({
      orderId,
      userId,
      amount: parsedAmount,
      status: 'PENDING',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      tranzupiResponse: tranzResponse
    });

    return res.json({
      success: true,
      paymentUrl,
      qrData: paymentUrl,
      orderId,
      status: 'PENDING'
    });

  } catch (err) {
    console.error('CreateOrder Error:', err.message);
    if (err.response) {
      console.error('TranzUPI HTTP Status:', err.response.status);
      console.error('TranzUPI Data:', err.response.data);
    }
    return res.status(500).json({ error: err.message || 'Server error' });
  }
});

// ===== VERIFY ORDER =====
app.post('/api/wallet/verifyOrder', authenticateUser, async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ error: 'Missing orderId' });
    }

    const orderDocRef = db.collection('orders').doc(orderId);
    const orderDoc = await orderDocRef.get();

    if (!orderDoc.exists) {
      return res.status(404).json({ error: 'Order not found' });
    }

    const orderData = orderDoc.data();

    if (orderData.userId !== req.user.uid) {
      return res.status(403).json({ error: 'Unauthorized: order belongs to different user' });
    }

    if (orderData.status === 'PAID') {
      return res.json({ status: 'PAID', message: 'Order already processed' });
    }

    const verifyParams = {
      user_token: TRANZUPI_TOKEN,
      order_id: orderId
    };

    const verifyResponse = await callTranzUPI('/api/check-order-status', verifyParams);

    // FIXED: txnStatus 'SUCCESS' hota hai (docs ke according)
    const result = verifyResponse.result || {};
    const isPaid = verifyResponse.status === 'COMPLETED' &&
                   result.txnStatus === 'SUCCESS';

    if (isPaid) {
      const userRef = db.collection('users').doc(orderData.userId);

      await db.runTransaction(async (t) => {
        const userDoc = await t.get(userRef);
        if (!userDoc.exists) throw new Error('User not found in Firestore');

        const freshOrder = await t.get(orderDocRef);
        if (freshOrder.data().status === 'PAID') return;

        const currentBalance = userDoc.data().balance || 0;
        const newBalance = currentBalance + orderData.amount;

        t.update(userRef, {
          balance: newBalance,
          transactions: admin.firestore.FieldValue.arrayUnion({
            type: 'credit',
            amount: orderData.amount,
            msg: `Wallet Recharge (Order: ${orderId})`,
            date: Date.now(),
            orderId
          })
        });

        t.update(orderDocRef, {
          status: 'PAID',
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      });

      return res.json({ status: 'PAID', message: 'Payment verified and wallet credited' });
    }

    return res.json({
      status: 'PENDING',
      message: 'Payment still pending',
      tranzupiStatus: verifyResponse.status,
      txnStatus: result.txnStatus || 'unknown'
    });

  } catch (err) {
    console.error('VerifyOrder Error:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
});

// ===== WEBHOOK =====
app.post('/api/wallet/webhook', async (req, res) => {
  console.log('Webhook received at:', new Date().toISOString());
  console.log('Webhook body:', req.body);

  // TranzUPI: HAMESHA 200 OK bhejo warna 5 baar retry karega
  res.set('Content-Type', 'text/plain');
  res.status(200).send('OK');

  setImmediate(async () => {
    try {
      const { order_id, utr } = req.body;

      if (!order_id) {
        console.log('Webhook: Missing order_id');
        return;
      }

      const orderDocRef = db.collection('orders').doc(order_id);
      const orderDoc = await orderDocRef.get();

      if (!orderDoc.exists) {
        console.log('Webhook: Order not found:', order_id);
        return;
      }

      const orderData = orderDoc.data();

      if (orderData.status === 'PAID') {
        console.log('Webhook: Already paid, skipping:', order_id);
        return;
      }

      console.log('Webhook: Re-verifying with TranzUPI...');
      const verifyParams = {
        user_token: TRANZUPI_TOKEN,
        order_id
      };

      let isActuallyPaid = false;
      try {
        const verifyResponse = await callTranzUPI('/api/check-order-status', verifyParams);
        const result = verifyResponse.result || {};
        isActuallyPaid = verifyResponse.status === 'COMPLETED' && result.txnStatus === 'SUCCESS';
        console.log('Webhook re-verify:', isActuallyPaid ? 'PAID' : 'NOT PAID');
      } catch (verifyError) {
        console.error('Webhook re-verify failed:', verifyError.message);
        return;
      }

      if (isActuallyPaid) {
        const userRef = db.collection('users').doc(orderData.userId);
        await db.runTransaction(async (t) => {
          const userDoc = await t.get(userRef);
          if (!userDoc.exists) throw new Error('User not found');

          const freshOrder = await t.get(orderDocRef);
          if (freshOrder.data().status === 'PAID') return;

          const currentBalance = userDoc.data().balance || 0;
          t.update(userRef, {
            balance: currentBalance + orderData.amount,
            transactions: admin.firestore.FieldValue.arrayUnion({
              type: 'credit',
              amount: orderData.amount,
              msg: `Wallet Recharge via Webhook (Order: ${order_id})`,
              date: Date.now(),
              orderId: order_id,
              utr: utr || 'N/A'
            })
          });
          t.update(orderDocRef, {
            status: 'PAID',
            paidAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          });
        });
        console.log('Webhook: Wallet credited for order:', order_id);
      }

    } catch (err) {
      console.error('Webhook processing error:', err.message);
    }
  });
});

// ===== ERROR HANDLERS =====
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  setTimeout(() => process.exit(1), 1000);
});

app.use((err, req, res, next) => {
  console.error('Express Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// ===== START SERVER =====
app.listen(PORT, () => {
  console.log(`Server started on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
  console.log(`Webhook URL: POST /api/wallet/webhook`);
});

module.exports = app;
