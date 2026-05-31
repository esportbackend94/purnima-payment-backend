const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();
const admin = require('firebase-admin');

const app = express();

// ===== CORS FIX =====
app.use(cors({
  origin: '*',  // Temporary - sabko allow karo debugging ke liye
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 5000;

// ===== FIREBASE =====
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
  console.log("✅ Firebase connected");
} catch (err) {
  console.error("❌ Firebase Error:", err.message);
  process.exit(1);
}

const db = admin.firestore();

// ===== CONFIG =====
const TRANZUPI_TOKEN = process.env.TRANZUPI_USER_TOKEN;
const TRANZUPI_MOBILE = process.env.TRANZUPI_MOBILE || '9999999999';

// ===== ROUTES =====
app.get('/', (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

app.get('/health', (req, res) => res.status(200).send('OK'));

// Auth middleware
const authMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing token' });
    }
    const token = authHeader.split('Bearer ')[1];
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = decoded;
    next();
  } catch (e) {
    console.error('Auth error:', e.message);
    res.status(401).json({ error: 'Invalid token' });
  }
};

// ===== CREATE ORDER =====
app.post('/api/wallet/createOrder', authMiddleware, async (req, res) => {
  try {
    console.log('📥 CreateOrder called by:', req.user.uid);
    console.log('📥 Body:', req.body);

    const { amount, orderId, userId } = req.body;
    
    if (!amount || !orderId || !userId) {
      return res.status(400).json({ error: 'Missing: amount, orderId, userId' });
    }

    if (req.user.uid !== userId) {
      return res.status(403).json({ error: 'UID mismatch' });
    }

    // TranzUPI call
    const payload = new URLSearchParams();
    payload.append('customer_mobile', TRANZUPI_MOBILE);
    payload.append('user_token', TRANZUPI_TOKEN);
    payload.append('amount', parseFloat(amount).toFixed(2));
    payload.append('order_id', orderId);
    payload.append('redirect_url', 'https://purnima-esport.web.app');
    payload.append('remark1', 'Wallet Recharge');

    console.log('📤 Calling TranzUPI...');

    const response = await axios.post('https://tranzupi.com/api/create-order', payload, {
      headers: { 
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0'
      },
      timeout: 15000
    });

    console.log('📥 TranzUPI response:', response.data);

    const data = response.data;
    
    if (data.status === true || data.success === true) {
      const result = data.result || data;
      
      await db.collection('orders').doc(orderId).set({
        orderId, userId, amount: parseFloat(amount),
        status: 'PENDING',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return res.json({
        success: true,
        qrData: result.payment_url,
        orderId,
        upiId: result.upi_id || 'payment@tranzupi'
      });
    }

    return res.status(400).json({ 
      error: data.message || 'TranzUPI failed',
      details: data 
    });

  } catch (err) {
    console.error('❌ CreateOrder Error:', err.message);
    if (err.response) {
      console.error('TranzUPI status:', err.response.status);
      console.error('TranzUPI data:', err.response.data);
    }
    res.status(500).json({ error: err.message });
  }
});

// ===== VERIFY ORDER =====
app.post('/api/wallet/verifyOrder', authMiddleware, async (req, res) => {
  try {
    const { orderId } = req.body;
    if (!orderId) return res.status(400).json({ error: 'Missing orderId' });

    const orderDoc = await db.collection('orders').doc(orderId).get();
    if (!orderDoc.exists) return res.status(404).json({ error: 'Order not found' });

    const orderData = orderDoc.data();
    if (orderData.userId !== req.user.uid) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    if (orderData.status === 'PAID') {
      return res.json({ status: 'PAID', message: 'Already processed' });
    }

    // Verify with TranzUPI
    const payload = new URLSearchParams();
    payload.append('user_token', TRANZUPI_TOKEN);
    payload.append('order_id', orderId);

    const response = await axios.post('https://tranzupi.com/api/check-order-status', payload, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 15000
    });

    const result = response.data.result || response.data;
    const isPaid = response.data.status === 'COMPLETED' && 
                   (result.status === 'SUCCESS' || result.txnStatus === 'COMPLETED');

    if (isPaid) {
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
    console.error('❌ Verify Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ===== WEBHOOK =====
app.post('/api/wallet/webhook', async (req, res) => {
  console.log('🔔 Webhook:', req.body);
  
  // ALWAYS return 200 immediately
  res.set('Content-Type', 'text/plain');
  res.status(200).send('OK');

  // Process in background
  try {
    const { order_id } = req.body;
    if (!order_id) return;

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
    const isPaid = verifyRes.data.status === 'COMPLETED' && result.status === 'SUCCESS';

    if (isPaid) {
      const userRef = db.collection('users').doc(orderData.userId);
      await db.runTransaction(async (t) => {
        const userDoc = await t.get(userRef);
        const newBal = (userDoc.data().balance || 0) + orderData.amount;
        
        t.update(userRef, {
          balance: newBal,
          transactions: admin.firestore.FieldValue.arrayUnion({
            type: 'credit', amount: orderData.amount,
            msg: `Webhook ${order_id}`, date: Date.now()
          })
        });
        t.update(db.collection('orders').doc(order_id), { status: 'PAID' });
      });
    }
  } catch (err) {
    console.error('Webhook processing error:', err.message);
  }
});

// Error handler
app.use((err, req, res, next) => {
  console.error('Express Error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
