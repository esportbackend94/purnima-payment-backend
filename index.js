const express = require('express');
const cors = require('cors');
const axios = require('axios');
require('dotenv').config();
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 5000;

 // === Firebase Admin SDK Initialization ===
const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;

if (!serviceAccountJson) {
  console.error("❌ CRITICAL ERROR: FIREBASE_SERVICE_ACCOUNT environment variable is missing on Render!");
  process.exit(1); // सर्वर को तुरंत बंद करें ताकि गलत कॉन्फ़िगरेशन का पता चले
}

try {
  admin.initializeApp({
    credential: admin.credential.cert(JSON.parse(serviceAccountJson))
  });
  console.log("✅ Firebase Admin initialized successfully via Env Variable.");
} catch (err) {
  console.error("❌ CRITICAL ERROR: Failed to parse or initialize Firebase Admin JSON:", err.message);
  process.exit(1); // पार्सिंग फेल होने पर सर्वर बंद करें
}

const db = admin.firestore();

// === Middleware: Verify Firebase Auth Token ===
const authenticateUser = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized: Missing token' });
  }

  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken; // Decoded object contains 'uid', 'email', etc.
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

    // Token UID validation for security
    if (req.user.uid !== userId) {
      return res.status(403).json({ error: 'Forbidden: UID mismatch' });
    }

    const apiSecret = process.env.TRANZUPI_API_SECRET;
    const mobile = process.env.TRANZUPI_MOBILE;
    const baseUrl = process.env.TRANZUPI_BASE_URL || 'https://server.tranzupi.com';

    // Prepare API Request to TranzUPI
    const payload = {
      api_secret: apiSecret,
      mobile: mobile,
      amount: parseFloat(amount).toFixed(2),
      order_id: orderId,
      customer_name: userName || 'Gamer',
      customer_email: userEmail || 'user@gmail.com',
      redirect_url: `https://purnima-esport.web.app` // Change this to your frontend URL
    };

    console.log(`Sending order create request to TranzUPI for order ${orderId} amount ${amount}`);

    const tranzResponse = await axios.post(`${baseUrl}/api/create_order`, payload);
    const resData = tranzResponse.data;

    // Check if order is generated successfully
    if (resData.status === true || resData.status === 'success' || resData.success === true) {
      const gatewayData = resData.data || resData;
      
      const qrData = gatewayData.qr_data || gatewayData.qrData || gatewayData.payment_url || gatewayData.paymentUrl || `upi://pay?pa=${gatewayData.upi_id || gatewayData.upiId}&pn=PurnimaESports&am=${amount}&tr=${orderId}`;
      const upiId = gatewayData.upi_id || gatewayData.upiId || 'payment@tranzupi';

      // Save order metadata as PENDING in Firestore
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

    // 1. Fetch order details from Firestore
    const orderDocRef = db.collection('orders').doc(orderId);
    const orderDoc = await orderDocRef.get();

    if (!orderDoc.exists) {
      return res.status(404).json({ error: 'Order records not found' });
    }

    const orderData = orderDoc.data();

    // Prevent cross-user checks
    if (orderData.userId !== req.user.uid) {
      return res.status(403).json({ error: 'Unauthorized order access' });
    }

    if (orderData.status === 'PAID') {
      return res.json({ status: 'PAID', message: 'Order was already successfully processed.' });
    }

    // 2. Verify with TranzUPI check_status API
    const apiSecret = process.env.TRANZUPI_API_SECRET;
    const mobile = process.env.TRANZUPI_MOBILE;
    const baseUrl = process.env.TRANZUPI_BASE_URL || 'https://server.tranzupi.com';

    const payload = {
      api_secret: apiSecret,
      mobile: mobile,
      order_id: orderId
    };

    console.log(`Checking transaction status on TranzUPI for order: ${orderId}`);
    const checkResponse = await axios.post(`${baseUrl}/api/check_status`, payload);
    const resData = checkResponse.data;

    const gatewayData = resData.data || resData;
    const isPaid = (
      resData.status === 'success' || 
      resData.success === true || 
      gatewayData.status === 'SUCCESS' || 
      gatewayData.status === 'COMPLETED' || 
      gatewayData.status === 'PAID'
    );

    if (isPaid) {
      const userRef = db.collection('users').doc(orderData.userId);
      const amount = orderData.amount;

      // 3. SECURELY deposit balance inside database transaction to avoid double spending
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

        // Add amount to balance and update transaction array
        transaction.update(userRef, {
          balance: newBalance,
          transactions: admin.firestore.FieldValue.arrayUnion({
            type: 'credit',
            amount: amount,
            msg: `Recharged Wallet (Txn: ${orderId})`,
            date: Date.now()
          })
        });

        // Mark order status as PAID
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

// === Endpoint 3: Webhook (For backup status notifications from TranzUPI) ===
app.post('/api/wallet/webhook', async (req, res) => {
  try {
    const { order_id, status } = req.body;
    console.log(`Webhook received: Order: ${order_id}, Status: ${status}`);

    if (!order_id) {
      return res.status(400).send('Missing order_id');
    }

    const orderDocRef = db.collection('orders').doc(order_id);
    const orderDoc = await orderDocRef.get();

    if (!orderDoc.exists) {
      return res.status(404).send('Order not found');
    }

    const orderData = orderDoc.data();
    if (orderData.status === 'PAID') {
      return res.send('OK'); // Already processed
    }

    // Perform double verification check against API to verify authenticity
    const apiSecret = process.env.TRANZUPI_API_SECRET;
    const mobile = process.env.TRANZUPI_MOBILE;
    const baseUrl = process.env.TRANZUPI_BASE_URL || 'https://server.tranzupi.com';

    const checkResponse = await axios.post(`${baseUrl}/api/check_status`, {
      api_secret: apiSecret,
      mobile: mobile,
      order_id: order_id
    });

    const gatewayData = checkResponse.data.data || checkResponse.data;
    const isPaid = (
      checkResponse.data.status === 'success' || 
      checkResponse.data.success === true || 
      gatewayData.status === 'SUCCESS' || 
      gatewayData.status === 'COMPLETED' || 
      gatewayData.status === 'PAID'
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

    return res.send('OK');
  } catch (error) {
    console.error('Webhook error:', error.message);
    return res.status(500).send('Webhook Process Error');
  }
});

app.listen(PORT, () => {
  console.log(`Purnima Payment server is running on port ${PORT}`);
});
