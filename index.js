const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();
const admin = require('firebase-admin');

const app = express();

// ===== CORS - ALLOW ALL FOR TESTING (Production mein restrict karna) =====
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
  console.error("❌ CRITICAL: FIREBASE_SERVICE_ACCOUNT missing!");
  process.exit(1);
}

try {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(serviceAccountJson))
  });
  console.log("✅ Firebase Admin connected");
} catch (err) {
  console.error("❌ Firebase init failed:", err.message);
  process.exit(1);
}

const db = admin.firestore();

// ===== CONFIG =====
const TRANZUPI_TOKEN = process.env.TRANZUPI_USER_TOKEN || process.env.TRANZUPI_API_SECRET;
const TRANZUPI_MOBILE = process.env.TRANZUPI_MOBILE || '9999999999';

if (!TRANZUPI_TOKEN) {
  console.error("❌ WARNING: TRANZUPI_USER_TOKEN missing!");
}

// ===== HELPER: TranzUPI API Call =====
async function callTranzUPI(endpoint, params) {
  const payload = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      payload.append(key, String(value));
    }
  }

  console.log(`📡 TranzUPI: ${endpoint}`);
  
  try {
    const response = await axios.post(`https://tranzupi.com${endpoint}`, payload, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*'
      },
      timeout: 15000
    });
    
    console.log(`✅ TranzUPI Response:`, JSON.stringify(response.data, null, 2));
    return response.data;
    
  } catch (error) {
    console.error(`❌ TranzUPI Error (${endpoint}):`, error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', error.response.data);
    }
    throw error;
  }
}

// ===== AUTH MIDDLEWARE =====
const authenticateUser = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized: Missing token' });
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

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: "ok", 
    time: new Date().toISOString(),
    firebase: "connected",
    tranzupi: TRANZUPI_TOKEN ? "configured" : "missing"
  });
});

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// ===== CREATE ORDER =====
app.post('/api/wallet/createOrder', authenticateUser, async (req, res) => {
  try {
    console.log('📥 CreateOrder called by:', req.user.uid);
    console.log('📥 Body:', req.body);

    const { amount, orderId, userId, userEmail, userName } = req.body;

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

    // Call TranzUPI
    const tranzParams = {
      customer_mobile: TRANZUPI_MOBILE,
      user_token: TRANZUPI_TOKEN,
      amount: parsedAmount.toFixed(2),
      order_id: orderId,
      redirect_url: process.env.REDIRECT_URL || 'https://purnima-esport.web.app',
      remark1: 'Wallet Recharge',
      remark2: userName || userEmail || 'Gamer'
    };

    const tranzResponse = await callTranzUPI('/api/create-order', tranzParams);

    const isSuccess = tranzResponse.status === true || 
                      tranzResponse.status === 'success' || 
                      tranzResponse.success === true;

    if (!isSuccess) {
      console.error('TranzUPI failed:', tranzResponse);
      return res.status(400).json({ 
        error: tranzResponse.message || 'TranzUPI order creation failed',
        details: tranzResponse 
      });
    }

    const result = tranzResponse.result || tranzResponse.data || tranzResponse;
    const paymentUrl = result.payment_url || result.paymentUrl;
    const upiId = result.upi_id || result.upiId || 'payment@tranzupi';

    if (!paymentUrl) {
      return res.status(500).json({ 
        error: 'Payment URL not received from TranzUPI',
        response: tranzResponse 
      });
    }

    // Save to Firestore
    await db.collection('orders').doc(orderId).set({
      orderId: orderId,
      userId: userId,
      amount: parsedAmount,
      status: 'PENDING',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      tranzupiResponse: tranzResponse
    });

    return res.json({
      success: true,
      qrData: paymentUrl,
      paymentUrl: paymentUrl,
      orderId: orderId,
      upiId: upiId,
      status: 'PENDING'
    });

  } catch (err) {
    console.error('❌ CreateOrder Error:', err.message);
    if (err.response) {
      console.error('TranzUPI status:', err.response.status);
      console.error('TranzUPI data:', err.response.data);
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
      return res.status(403).json({ error: 'Unauthorized order access' });
    }

    if (orderData.status === 'PAID') {
      return res.json({ 
        status: 'PAID', 
        message: 'Order already processed' 
      });
    }

    // Re-verify with TranzUPI
    const verifyParams = {
      user_token: TRANZUPI_TOKEN,
      order_id: orderId
    };

    const verifyResponse = await callTranzUPI('/api/check-order-status', verifyParams);
    
    const result = verifyResponse.result || verifyResponse;
    const isPaid = verifyResponse.status === 'COMPLETED' && 
                   (result.status === 'SUCCESS' || result.txnStatus === 'COMPLETED');

    if (isPaid) {
      // Credit wallet
      const userRef = db.collection('users').doc(orderData.userId);
      await db.runTransaction(async (t) => {
        const userDoc = await t.get(userRef);
        if (!userDoc.exists) throw new Error('User not found');

        const currentBalance = userDoc.data().balance || 0;
        const newBalance = currentBalance + orderData.amount;

        const orderSnap = await t.get(orderDocRef);
        if (orderSnap.data().status === 'PAID') return;

        t.update(userRef, {
          balance: newBalance,
          transactions: admin.firestore.FieldValue.arrayUnion({
            type: 'credit',
            amount: orderData.amount,
            msg: `Wallet Recharge (Order: ${orderId})`,
            date: Date.now(),
            orderId: orderId
          })
        });

        t.update(orderDocRef, {
          status: 'PAID',
          paidAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      });

      return res.json({ 
        status: 'PAID', 
        message: 'Payment verified and wallet credited' 
      });
    }

    return res.json({ 
      status: 'PENDING', 
      message: 'Payment still pending',
      tranzupiStatus: verifyResponse.status,
      result: result
    });

  } catch (err) {
    console.error('❌ Verify Error:', err.message);
    return res.status(500).json({ error: err.message || 'Server error' });
  }
});

// ===== WEBHOOK =====
app.post('/api/wallet/webhook', async (req, res) => {
  console.log('🔔 Webhook received:', new Date().toISOString());
  console.log('📥 Body:', req.body);
  console.log('📥 Content-Type:', req.headers['content-type']);

  // ALWAYS return 200 OK immediately (TranzUPI ko retry नहीं करने देना)
  res.set('Content-Type', 'text/plain');
  res.status(200).send('OK');

  // Background processing
  try {
    const { order_id, amount, status: webhookStatus, utr } = req.body;

    if (!order_id) {
      console.log('⚠️ Webhook missing order_id');
      return;
    }

    const orderDocRef = db.collection('orders').doc(order_id);
    const orderDoc = await orderDocRef.get();

    if (!orderDoc.exists) {
      console.log('⚠️ Order not found:', order_id);
      return;
    }

    const orderData = orderDoc.data();

    // Idempotency check - already paid?
    if (orderData.status === 'PAID') {
      console.log('✅ Order already paid, ignoring duplicate');
      return;
    }

    // CRITICAL: Re-verify with TranzUPI before crediting
    console.log('🔍 Re-verifying payment...');
    
    const verifyParams = {
      user_token: TRANZUPI_TOKEN,
      order_id: order_id
    };

    let isActuallyPaid = false;
    
    try {
      const verifyResponse = await callTranzUPI('/api/check-order-status', verifyParams);
      const result = verifyResponse.result || verifyResponse;
      
      isActuallyPaid = (
        verifyResponse.status === 'COMPLETED' &&
        (result.status === 'SUCCESS' || result.txnStatus === 'COMPLETED')
      );
      
      console.log('Re-verification result:', isActuallyPaid ? 'PAID' : 'NOT PAID');
      
    } catch (verifyError) {
      console.error('❌ Re-verification failed:', verifyError.message);
      return; // Don't credit if verification fails
    }

    if (isActuallyPaid) {
      const userRef = db.collection('users').doc(orderData.userId);
      await db.runTransaction(async (t) => {
        const userDoc = await t.get(userRef);
        if (!userDoc.exists) throw new Error('User not found');

        const currentBalance = userDoc.data().balance || 0;
        const newBalance = currentBalance + orderData.amount;

        const orderSnap = await t.get(orderDocRef);
        if (orderSnap.data().status === 'PAID') return;

        t.update(userRef, {
          balance: newBalance,
          transactions: admin.firestore.FieldValue.arrayUnion({
            type: 'credit',
            amount: orderData.amount,
            msg: `Webhook Recharge (Order: ${order_id})`,
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

      console.log('✅ Wallet credited via webhook for order:', order_id);
    } else {
      console.log('⚠️ Payment not confirmed, skipping credit');
    }

  } catch (err) {
    console.error('❌ Webhook processing error:', err.message);
    // Already sent 200, so TranzUPI won't retry
  }
});

// ===== ERROR HANDLERS =====
process.on('unhandledRejection', (reason, promise) => {
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
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📋 Health: http://localhost:${PORT}/health`);
  console.log(`🔔 Webhook: POST ${PORT}/api/wallet/webhook`);
});

module.exports = app;
