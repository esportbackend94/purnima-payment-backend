const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json());
// Webhook और URL-Encoded रिक्वेस्ट पार्स करने के लिए आवश्यक Middleware
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 5000;

// === Firebase Admin SDK Initialization ===
const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!serviceAccountJson) {
  console.error("❌ CRITICAL ERROR: FIREBASE_SERVICE_ACCOUNT environment variable is missing on Render!");
  process.exit(1);
}

try {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(serviceAccountJson))
  });
  console.log("✅ Firebase Admin initialized successfully via Env Variable.");
} catch (err) {
  console.error("❌ CRITICAL ERROR: Failed to parse or initialize Firebase Admin JSON:", err.message);
  process.exit(1);
}

const db = admin.firestore();

// === Web Home Route (Shows Live Status on Web Browser) ===
app.get('/', (req, res) => {
  res.json({
    status: "active",
    message: "Purnima E-Sports Payment Gateway Backend is running successfully!",
    firebaseAdmin: "connected"
  });
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
    console.error('Firebase Auth verification failed:', error.message);
    return res.status(401).json({ error: 'Unauthorized: Invalid token' });
  }
};

// === Endpoint 1: Create Order ===
app.post('/api/wallet/createOrder', authenticateUser, async (req, res) => {
  try {
    const { amount, orderId, userId, userEmail, userName } = req.body;

    if (!amount || !orderId || !userId) {
      return res.status(400).json({ error: 'Missing required parameters: amount, orderId, and userId' });
    }

    if (req.user.uid !== userId) {
      return res.status(403).json({ error: 'Forbidden: UID mismatch' });
    }

    // Config parameters from Env variables
    const userToken = process.env.TRANZUPI_USER_TOKEN || process.env.TRANZUPI_API_SECRET;
    const mobile = process.env.TRANZUPI_MOBILE || '9999999999';
    const baseUrl = 'https://tranzupi.com'; // Fixed base URL

    // URL-Encoded फॉर्मेट में डेटा तैयार करना (डॉक्यूमेंटेशन के अनुसार)
    const params = new URLSearchParams();
    params.append('customer_mobile', mobile);
    params.append('user_token', userToken);
    params.append('amount', parseFloat(amount).toFixed(2));
    params.append('order_id', orderId);
    params.append('redirect_url', `https://purnima-esport.web.app`); // Your redirection URL
    params.append('remark1', 'Wallet Recharge');
    params.append('remark2', userName || 'Gamer');

    console.log(`Sending order create request to TranzUPI for order ${orderId} amount ${amount}`);

    const tranzResponse = await axios.post(`${baseUrl}/api/create-order`, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    
    const resData = tranzResponse.data;

    if (resData.status === true || resData.status === 'success' || resData.success === true) {
      const gatewayData = resData.result || resData.data || resData;
      
      const qrData = gatewayData.payment_url || gatewayData.qr_data || gatewayData.paymentUrl;
      const upiId = gatewayData.upi_id || gatewayData.upiId || 'payment@tranzupi';

      await db.collection('orders').doc(orderId).set({
        orderId: orderId,
        userId: userId,
        amount: parseFloat(amount),
        status: 'PENDING',
        createdAt: admin.firestore.FieldValue.serverTimestamp()
      });

      return res.json({
        qrData: qrData,
        orderId: orderId,
        upiId: upiId,
        status: 'PENDING'
      });
    } else {
      console.error('TranzUPI error response:', resData);
      return res.status(400).json({ error: resData.message || 'TranzUPI order creation failed' });
    }
  } catch (error) {
    console.error('Error creating order:', error.message);
    return res.status(500).json({ error: error.message || 'Server error creating payment order' });
  }
});

// === Endpoint 2: Verify Order Status ===
app.post('/api/wallet/verifyOrder', authenticateUser, async (req, res) => {
  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ error: 'Missing orderId parameter' });
    }

    const orderDocRef = db.collection('orders').doc(orderId);
    const orderDoc = await orderDocRef.get();

    if (!orderDoc.exists) {
      return res.status(404).json({ error: 'Order records not found' });
    }

    const orderData = orderDoc.data();

    if (orderData.userId !== req.user.uid) {
      return res.status(403).json({ error: 'Unauthorized order access' });
    }

    if (orderData.status === 'PAID') {
      return res.json({ status: 'PAID', message: 'Order was already successfully processed.' });
    }

    const userToken = process.env.TRANZUPI_USER_TOKEN || process.env.TRANZUPI_API_SECRET;
    const baseUrl = 'https://tranzupi.com';

    // Verify status via URL-Encoded check status API
    const params = new URLSearchParams();
    params.append('user_token', userToken);
    params.append('order_id', orderId);

    console.log(`Checking transaction status on TranzUPI for order: ${orderId}`);
    
    const checkResponse = await axios.post(`${baseUrl}/api/check-order-status`, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });
    
    const resData = checkResponse.data;

    // डॉक्यूमेंटेशन के अनुसार Success चेक करना (status: COMPLETED और result.status: SUCCESS)
    const isPaid = (
      resData.status === 'COMPLETED' &&
      resData.result &&
      (resData.result.status === 'SUCCESS' || resData.result.txnStatus === 'COMPLETED')
    );

    if (isPaid) {
      const userRef = db.collection('users').doc(orderData.userId);
      const amount = orderData.amount;

      await db.runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userRef);
        if (!userDoc.exists) {
          throw new Error('User record does not exist!');
        }

        const currentBalance = userDoc.data().balance || 0;
        const newBalance = currentBalance + amount;

        const orderSnap = await transaction.get(orderDocRef);
        if (orderSnap.data().status === 'PAID') {
          throw new Error('Order already paid!');
        }

        transaction.update(userRef, {
          balance: newBalance,
          transactions: admin.firestore.FieldValue.arrayUnion({
            type: 'credit',
            amount: amount,
            msg: `Recharged Wallet (Txn: ${orderId})`,
            date: Date.now()
          })
        });

        transaction.update(orderDocRef, {
          status: 'PAID',
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      });

      console.log(`Order ${orderId} verified and balance updated for ${orderData.userId}`);
      return res.json({ status: 'PAID', message: 'Payment successfully added to wallet' });
    } else {
      return res.json({ status: orderData.status || 'PENDING', message: 'Payment verification is still pending' });
    }
  } catch (error) {
    console.error('Error verifying order:', error.message);
    return res.status(500).json({ error: error.message || 'Server error verifying payment status' });
  }
});

// === Endpoint 3: Webhook (Callback handling) ===
app.post('/api/wallet/webhook', async (req, res) => {
  try {
    // TranzUPI वेबहुक से URL-Encoded डेटा भेजता है
    const { order_id, status } = req.body;
    console.log(`Webhook received: Order: ${order_id}, Status: ${status}`);

    if (!order_id) {
      res.setHeader('Content-Type', 'text/plain');
      return res.status(400).send('BAD REQUEST');
    }

    const orderDocRef = db.collection('orders').doc(order_id);
    const orderDoc = await orderDocRef.get();

    if (!orderDoc.exists) {
      res.setHeader('Content-Type', 'text/plain');
      return res.status(404).send('ORDER NOT FOUND');
    }

    const orderData = orderDoc.data();
    if (orderData.status === 'PAID') {
      res.setHeader('Content-Type', 'text/plain');
      return res.status(200).send('OK'); // Already processed
    }

    const userToken = process.env.TRANZUPI_USER_TOKEN || process.env.TRANZUPI_API_SECRET;
    const baseUrl = 'https://tranzupi.com';

    // Verify webhook data via check-status API to avoid fake payloads
    const params = new URLSearchParams();
    params.append('user_token', userToken);
    params.append('order_id', order_id);

    const checkResponse = await axios.post(`${baseUrl}/api/check-order-status`, params, {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      }
    });

    const resData = checkResponse.data;
    const isPaid = (
      resData.status === 'COMPLETED' &&
      resData.result &&
      (resData.result.status === 'SUCCESS' || resData.result.txnStatus === 'COMPLETED')
    );

    if (isPaid) {
      const userRef = db.collection('users').doc(orderData.userId);
      const amount = orderData.amount;

      await db.runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userRef);
        if (!userDoc.exists) return;

        const currentBalance = userDoc.data().balance || 0;
        const newBalance = currentBalance + amount;

        const orderSnap = await transaction.get(orderDocRef);
        if (orderSnap.data().status === 'PAID') return;

        transaction.update(userRef, {
          balance: newBalance,
          transactions: admin.firestore.FieldValue.arrayUnion({
            type: 'credit',
            amount: amount,
            msg: `Recharged Wallet (Webhook: ${order_id})`,
            date: Date.now()
          })
        });

        transaction.update(orderDocRef, {
          status: 'PAID',
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      });

      console.log(`Webhook updated payment status successfully for ${order_id}`);
    }

    // डॉक्यूमेंटेशन के अनुसार रिप्लाई हमेशा text/plain 'OK' होना चाहिए
    res.setHeader('Content-Type', 'text/plain');
    return res.status(200).send('OK');
  } catch (error) {
    console.error('Webhook error:', error.message);
    res.setHeader('Content-Type', 'text/plain');
    return res.status(500).send('ERROR');
  }
});

app.listen(PORT, () => {
  console.log(`Purnima Payment server is running on port ${PORT}`);
});
