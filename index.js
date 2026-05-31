const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true })); // ✅ TranzUPI webhook form-data के लिए

const PORT = process.env.PORT || 5000;

// === Firebase Admin SDK Initialization ===
const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!serviceAccountJson) {
  console.error("❌ CRITICAL ERROR: FIREBASE_SERVICE_ACCOUNT environment variable is missing!");
  process.exit(1);
}

try {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(serviceAccountJson))
  });
  console.log("✅ Firebase Admin initialized successfully.");
} catch (err) {
  console.error("❌ Firebase Admin init failed:", err.message);
  process.exit(1);
}

const db = admin.firestore();

// === TranzUPI Config ===
const TRANZUPI_BASE_URL = 'https://tranzupi.com';
const TRANZUPI_USER_TOKEN = process.env.TRANZUPI_USER_TOKEN || process.env.TRANZUPI_API_SECRET;
const TRANZUPI_MOBILE = process.env.TRANZUPI_MOBILE || '9999999999';

if (!TRANZUPI_USER_TOKEN) {
  console.error("❌ CRITICAL: TRANZUPI_USER_TOKEN environment variable missing!");
}

// === Helper: Create URL-encoded payload ===
function createTranzPayload(params) {
  const payload = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) {
      payload.append(key, String(value));
    }
  }
  return payload;
}

// === Helper: TranzUPI API Call ===
async function callTranzUPI(endpoint, params) {
  const payload = createTranzPayload(params);
  
  console.log(`📡 TranzUPI API Call: ${endpoint}`);
  console.log(`📤 Payload keys:`, Object.keys(params).join(', '));

  try {
    const response = await axios.post(`${TRANZUPI_BASE_URL}${endpoint}`, payload, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Accept': 'application/json, text/plain, */*'
      },
      timeout: 15000 // 15 second timeout
    });
    
    console.log(`✅ TranzUPI Response:`, JSON.stringify(response.data, null, 2));
    return response.data;
    
  } catch (error) {
    console.error(`❌ TranzUPI API Error (${endpoint}):`, error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', error.response.data);
    }
    throw error;
  }
}

// === Web Home Route ===
app.get('/', (req, res) => {
  res.json({
    status: "active",
    message: "Purnima E-Sports Payment Gateway Backend is running!",
    firebaseAdmin: "connected",
    tranzupi: TRANZUPI_USER_TOKEN ? "configured" : "missing_token"
  });
});

// === Health Check (Render ke liye important) ===
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

// === Middleware: Verify Firebase Auth Token ===
const authenticateUser = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing token' });
  }

  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('Auth verification failed:', error.message);
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
};

// ==========================================
// === Endpoint 1: Create Order ===
// ==========================================
app.post('/api/wallet/createOrder', authenticateUser, async (req, res) => {
  try {
    const { amount, orderId, userId, userEmail, userName } = req.body;

    // Validation
    if (!amount || !orderId || !userId) {
      return res.status(400).json({ 
        error: 'Missing required parameters: amount, orderId, userId' 
      });
    }

    if (req.user.uid !== userId) {
      return res.status(403).json({ error: 'Forbidden: UID mismatch' });
    }

    const parsedAmount = parseFloat(amount);
    if (isNaN(parsedAmount) || parsedAmount <= 0) {
      return res.status(400).json({ error: 'Invalid amount' });
    }

    // ✅ TranzUPI ke exact parameters (documentation ke hisaab se)
    const tranzParams = {
      customer_mobile: TRANZUPI_MOBILE,
      user_token: TRANZUPI_USER_TOKEN,
      amount: parsedAmount.toFixed(2),
      order_id: orderId,
      redirect_url: process.env.REDIRECT_URL || 'https://purnima-esport.web.app',
      remark1: 'Wallet Recharge',
      remark2: userName || userEmail || 'Gamer'
    };

    // Call TranzUPI
    const tranzResponse = await callTranzUPI('/api/create-order', tranzParams);

    // Check success (documentation: status: true)
    const isSuccess = tranzResponse.status === true || 
                      tranzResponse.status === 'success' || 
                      tranzResponse.success === true;

    if (!isSuccess) {
      console.error('TranzUPI order creation failed:', tranzResponse);
      return res.status(400).json({ 
        error: tranzResponse.message || 'TranzUPI order creation failed',
        details: tranzResponse 
      });
    }

    // Extract payment URL from response
    const result = tranzResponse.result || tranzResponse.data || tranzResponse;
    const paymentUrl = result.payment_url || result.paymentUrl;
    const upiId = result.upi_id || result.upiId || 'payment@tranzupi';

    if (!paymentUrl) {
      return res.status(500).json({ 
        error: 'Payment URL not received from TranzUPI',
        response: tranzResponse 
      });
    }

    // Save order to Firestore
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
      qrData: paymentUrl,        // Frontend QR code banane ke liye
      paymentUrl: paymentUrl,     // Direct redirect ke liye
      orderId: orderId,
      upiId: upiId,
      status: 'PENDING'
    });

  } catch (error) {
    console.error('Create order error:', error.message);
    return res.status(500).json({ 
      error: error.message || 'Server error creating payment order' 
    });
  }
});

// ==========================================
// === Endpoint 2: Verify Order Status ===
// ==========================================
app.post('/api/wallet/verifyOrder', authenticateUser, async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ error: 'Missing orderId parameter' });
    }

    // Get order from Firestore
    const orderDocRef = db.collection('orders').doc(orderId);
    const orderDoc = await orderDocRef.get();

    if (!orderDoc.exists) {
      return res.status(404).json({ error: 'Order not found in database' });
    }

    const orderData = orderDoc.data();

    if (orderData.userId !== req.user.uid) {
      return res.status(403).json({ error: 'Unauthorized order access' });
    }

    // Agar pehle se PAID hai
    if (orderData.status === 'PAID') {
      return res.json({ 
        status: 'PAID', 
        message: 'Order was already successfully processed.' 
      });
    }

    // ✅ Re-verify with TranzUPI server
    const verifyParams = {
      user_token: TRANZUPI_USER_TOKEN,
      order_id: orderId
    };

    const verifyResponse = await callTranzUPI('/api/check-order-status', verifyParams);
    
    console.log('Verify response:', JSON.stringify(verifyResponse, null, 2));

    // Check payment status (documentation ke hisaab se)
    const result = verifyResponse.result || verifyResponse;
    const isPaid = (
      verifyResponse.status === 'COMPLETED' &&
      result && 
      (result.status === 'SUCCESS' || result.txnStatus === 'COMPLETED')
    );

    if (isPaid) {
      // Credit user wallet
      await creditUserWallet(orderData.userId, orderData.amount, orderId, orderDocRef);
      
      return res.json({ 
        status: 'PAID', 
        message: 'Payment successfully verified and added to wallet' 
      });
    }

    // Payment still pending
    return res.json({ 
      status: 'PENDING', 
      message: 'Payment verification is still pending',
      tranzupiStatus: verifyResponse.status,
      result: result
    });

  } catch (error) {
    console.error('Verify order error:', error.message);
    return res.status(500).json({ 
      error: error.message || 'Server error verifying payment status' 
    });
  }
});

// ==========================================
// === Endpoint 3: Webhook (CRITICAL FIX) ===
// ==========================================
app.post('/api/wallet/webhook', async (req, res) => {
  console.log('🔔 Webhook received at:', new Date().toISOString());
  console.log('📥 Webhook body:', req.body);
  console.log('📥 Content-Type:', req.headers['content-type']);

  try {
    // ✅ TranzUPI form-data bhejta hai (application/x-www-form-urlencoded)
    // Express urlencoded middleware already parse kar chuka hai
    const { 
      order_id, 
      amount, 
      customer_mobile,
      remark1,
      remark2,
      success_time,
      utr,
      status: webhookStatus,
      txn_remark 
    } = req.body;

    console.log('Parsed webhook data:', {
      order_id,
      amount,
      status: webhookStatus,
      utr
    });

    // Validate required fields
    if (!order_id) {
      console.error('❌ Webhook missing order_id');
      // ✅ TranzUPI ko bhi 200 bhejna hai taaki retry na kare
      res.set('Content-Type', 'text/plain');
      return res.status(200).send('OK');
    }

    // Get order from database
    const orderDocRef = db.collection('orders').doc(order_id);
    const orderDoc = await orderDocRef.get();

    // Agar order nahi mila, phir bhi 200 OK bhejo (idempotent)
    if (!orderDoc.exists) {
      console.warn('⚠️ Webhook: Order not found:', order_id);
      res.set('Content-Type', 'text/plain');
      return res.status(200).send('OK');
    }

    const orderData = orderDoc.data();

    // Agar pehle se PAID hai, duplicate webhook ignore karo
    if (orderData.status === 'PAID') {
      console.log('✅ Order already paid, ignoring duplicate webhook');
      res.set('Content-Type', 'text/plain');
      return res.status(200).send('OK');
    }

    // ✅ CRITICAL: Re-verify with TranzUPI before crediting (documentation recommendation)
    console.log('🔍 Re-verifying payment with TranzUPI...');
    
    const verifyParams = {
      user_token: TRANZUPI_USER_TOKEN,
      order_id: order_id
    };

    let isActuallyPaid = false;
    
    try {
      const verifyResponse = await callTranzUPI('/api/check-order-status', verifyParams);
      const result = verifyResponse.result || verifyResponse;
      
      isActuallyPaid = (
        verifyResponse.status === 'COMPLETED' &&
        result && 
        (result.status === 'SUCCESS' || result.txnStatus === 'COMPLETED')
      );
      
      console.log('Re-verification result:', isActuallyPaid ? 'PAID' : 'NOT PAID');
      
    } catch (verifyError) {
      console.error('❌ Re-verification failed:', verifyError.message);
      // Agar re-verify fail ho jaye, webhook ke status pe bharosa mat karo
      // Phir bhi 200 OK bhejo taaki TranzUPI retry na kare
      res.set('Content-Type', 'text/plain');
      return res.status(200).send('OK');
    }

    // ✅ Sirf tabhi credit karo jab re-verification successful ho
    if (isActuallyPaid) {
      await creditUserWallet(orderData.userId, orderData.amount, order_id, orderDocRef);
      console.log('✅ Wallet credited successfully via webhook');
    } else {
      console.log('⚠️ Payment not confirmed via re-verification, skipping credit');
    }

    // ✅ CRITICAL: Always return 200 OK with plain text (documentation ke hisaab se)
    // Agar 200 nahi mila to TranzUPI 5 baar retry karega
    res.set('Content-Type', 'text/plain');
    return res.status(200).send('OK');

  } catch (error) {
    console.error('❌ Webhook error:', error.message);
    // ✅ Error ke case mein bhi 200 OK bhejo, nahi to TranzUPI retry karega
    // Baad mein manually verify kar lena
    res.set('Content-Type', 'text/plain');
    return res.status(200).send('OK');
  }
});

// ==========================================
// === Helper: Credit User Wallet ===
// ==========================================
async function creditUserWallet(userId, amount, orderId, orderDocRef) {
  const userRef = db.collection('users').doc(userId);
  
  await db.runTransaction(async (transaction) => {
    const userDoc = await transaction.get(userRef);
    
    if (!userDoc.exists) {
      throw new Error('User record does not exist!');
    }

    // Idempotency check
    const orderSnap = await transaction.get(orderDocRef);
    if (orderSnap.data().status === 'PAID') {
      console.log('Transaction already processed, skipping');
      return;
    }

    const currentBalance = userDoc.data().balance || 0;
    const newBalance = currentBalance + parseFloat(amount);

    // Update user wallet
    transaction.update(userRef, {
      balance: newBalance,
      transactions: admin.firestore.FieldValue.arrayUnion({
        type: 'credit',
        amount: parseFloat(amount),
        msg: `Wallet Recharge (Order: ${orderId})`,
        date: Date.now(),
        orderId: orderId
      })
    });

    // Update order status
    transaction.update(orderDocRef, {
      status: 'PAID',
      paidAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    console.log(`💰 Credited ₹${amount} to user ${userId}. New balance: ₹${newBalance}`);
  });
}

// ==========================================
// === Error Handlers (503 fix ke liye) ===
// ==========================================
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  // Server ko crash hone se bachao, lekin gracefully shutdown karo
  setTimeout(() => process.exit(1), 1000);
});

// ==========================================
// === Start Server ===
// ==========================================
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📋 Health check: http://localhost:${PORT}/health`);
  console.log(`🔔 Webhook URL: https://your-render-url.onrender.com/api/wallet/webhook`);
});

module.exports = app;
