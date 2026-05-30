const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json());

// Firebase Initialize
let serviceAccount;
try {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} catch(e) {
  console.log('Firebase config error:', e.message);
}

if (serviceAccount) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

// TranzUPI Keys
const TRANZUPI_API_KEY = process.env.TRANZUPI_API_KEY;
const TRANZUPI_SECRET = process.env.TRANZUPI_SECRET;
const TRANZUPI_MERCHANT_ID = process.env.TRANZUPI_MERCHANT_ID;

// Token Verify
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

// Test Route
app.get('/', (req, res) => {
  res.json({ 
    message: 'Purnima Backend Running Successfully!',
    status: 'OK'
  });
});

// CREATE ORDER
app.post('/api/wallet/createOrder', verifyToken, async (req, res) => {
  try {
    const { amount, orderId, userName, userEmail } = req.body;
    const uid = req.uid;

    if (!amount || amount < 10) {
      return res.status(400).json({ error: 'Minimum amount Rs.10' });
    }

    // TranzUPI API Call
    const response = await axios.post(
      'https://api.tranzupi.com/v1/order/create',
      {
        merchant_id: TRANZUPI_MERCHANT_ID,
        order_id: orderId,
        amount: amount,
        currency: 'INR',
        customer_name: userName || 'User',
        customer_email: userEmail || 'user@gmail.com',
        redirect_url: 'https://purnima-esport.web.app',
        webhook_url: process.env.VERCEL_URL 
          ? `https://${process.env.VERCEL_URL}/api/webhook`
          : 'https://purnima-backend.vercel.app/api/webhook'
      },
      {
        headers: {
          'x-api-key': TRANZUPI_API_KEY,
          'x-api-secret': TRANZUPI_SECRET,
          'Content-Type': 'application/json'
        },
        timeout: 15000
      }
    );

    const data = response.data;

    // Firestore mein order save karo
    await db.collection('pending_orders').doc(orderId).set({
      uid: uid,
      amount: amount,
      orderId: orderId,
      status: 'PENDING',
      createdAt: Date.now()
    });

    return res.json({
      success: true,
      orderId: orderId,
      qrData: data.upi_string 
        || data.qr_data 
        || data.payment_url 
        || data.upi_url,
      upiId: data.upi_id 
        || data.vpa 
        || 'purnima@upi'
    });

  } catch (err) {
    console.log('CreateOrder Error:', err.message);
    if (err.response) {
      console.log('TranzUPI Response:', err.response.data);
    }
    return res.status(500).json({ 
      error: err.message,
      detail: err.response ? err.response.data : null
    });
  }
});

// VERIFY ORDER
app.post('/api/wallet/verifyOrder', verifyToken, async (req, res) => {
  try {
    const { orderId } = req.body;
    const uid = req.uid;

    // Firestore check
    const orderDoc = await db
      .collection('pending_orders')
      .doc(orderId)
      .get();
    
    if (!orderDoc.exists) {
      return res.json({ status: 'NOT_FOUND' });
    }

    const orderData = orderDoc.data();

    // Already paid check
    if (orderData.status === 'PAID') {
      return res.json({ status: 'PAID' });
    }

    // TranzUPI se status check
    const response = await axios.get(
      `https://api.tranzupi.com/v1/order/status/${orderId}`,
      {
        headers: {
          'x-api-key': TRANZUPI_API_KEY,
          'x-api-secret': TRANZUPI_SECRET
        },
        timeout: 10000
      }
    );

    const payStatus = response.data.status;

    if (payStatus === 'PAID' || payStatus === 'SUCCESS') {
      
      // Duplicate payment check
      const alreadyPaid = orderData.status === 'PAID';
      if (!alreadyPaid) {
        
        // Wallet mein paisa add karo
        await db.collection('users').doc(uid).update({
          balance: admin.firestore.FieldValue.increment(orderData.amount),
          transactions: admin.firestore.FieldValue.arrayUnion({
            type: 'credit',
            amount: orderData.amount,
            msg: 'Wallet Recharge: Rs.' + orderData.amount,
            date: Date.now()
          })
        });

        // Order status update
        await db.collection('pending_orders').doc(orderId).update({
          status: 'PAID',
          paidAt: Date.now()
        });
      }

      return res.json({ status: 'PAID' });
    }

    return res.json({ status: 'PENDING' });

  } catch (err) {
    console.log('VerifyOrder Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// WEBHOOK
app.post('/api/webhook', async (req, res) => {
  try {
    const body = req.body;
    const orderId = body.order_id || body.orderId;
    const status = body.status;

    console.log('Webhook received:', orderId, status);

    if (status === 'PAID' || status === 'SUCCESS') {
      const orderDoc = await db
        .collection('pending_orders')
        .doc(orderId)
        .get();
      
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

          console.log('Payment processed for order:', orderId);
        }
      }
    }

    res.json({ success: true });

  } catch (err) {
    console.log('Webhook Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Server started on port ' + PORT);
});
