require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');

const app = express();

// CORS और JSON Parser इनेबल करें
app.use(cors({ origin: '*' }));
app.use(express.json());

// Firebase Admin SDK इनिशियलाइज़ करें
try {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("Firebase Admin SDK initialized successfully.");
  } else {
    admin.initializeApp({
      credential: admin.credential.applicationDefault()
    });
    console.log("Firebase Admin initialized with default credentials.");
  }
} catch (error) {
    console.error("Firebase Initialization Error:", error.message);
}

const db = admin.firestore();

// Middleware: Firebase Auth Token वेरीफाई करने के लिए
async function verifyFirebaseToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: "Unauthorized access. Token missing." });
  }

  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken; // User details save dynamic validation के लिए
    next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid or expired Firebase token." });
  }
}

// 1. Endpoint: /api/wallet/createOrder (पेमेंट लिंक / QR जेनरेट करने के लिए)
app.post('/api/wallet/createOrder', verifyFirebaseToken, async (req, res) => {
  const { amount, orderId, userId, userEmail, userName } = req.body;

  if (!amount || !orderId || !userId) {
    return res.status(400).json({ error: "Missing required parameters (amount, orderId, userId)." });
  }

  try {
    // TranzUPI API के लिए पेलोड तैयार करें
    const tranzUpiPayload = {
      api_key: process.env.TRANZ_UPI_API_KEY,
      order_id: orderId,
      amount: amount,
      name: userName || "Player",
      email: userEmail || "player@purnima.com",
      redirect_url: process.env.REDIRECT_URL || "https://purnima-esport.firebaseapp.com",
      callback_url: process.env.CALLBACK_URL || ""
    };

    const targetUrl = `${process.env.TRANZ_UPI_BASE_URL}/create-order`;

    console.log(`Sending payment request to TranzUPI for Order: ${orderId}, Amount: ₹${amount}`);

    // TranzUPI के API एंडपॉइंट पर रिक्वेस्ट भेजें
    const gatewayResponse = await axios.post(targetUrl, tranzUpiPayload, {
      headers: { 'Content-Type': 'application/json' }
    });

    const result = gatewayResponse.data;

    // TranzUPI से प्राप्त होने वाले रिस्पॉन्स से QR स्ट्रिंग/पेमेंट डेटा और UPI ID निकालें
    // ध्यान दें: रिस्पॉन्स के ऑब्जेक्ट स्ट्रक्चर को आपके ट्रान्ज़यूपी प्लान के अनुसार मैप किया गया है
    const qrData = result.payment_url || (result.data ? result.data.payment_url : null);
    const upiId = result.upi_id || (result.data ? result.data.upi_id : null) || process.env.MERCHANT_UPI_ID;

    if (!qrData) {
      console.error("TranzUPI Response Error:", JSON.stringify(result));
      return res.status(500).json({ error: "Gateway failed to generate payment link." });
    }

    return res.json({
      success: true,
      qrData: qrData,
      orderId: orderId,
      upiId: upiId
    });

  } catch (error) {
    console.error("Create Order Error:", error.response ? error.response.data : error.message);
    return res.status(500).json({ error: "Internal Server Error during order creation." });
  }
});

// 2. Endpoint: /api/wallet/verifyOrder (पेमेंट स्टेटस चेक और वॉलेट में क्रेडिट करने के लिए)
app.post('/api/wallet/verifyOrder', verifyFirebaseToken, async (req, res) => {
  const { orderId } = req.body;
  const userId = req.user.uid; // Token से वेरीफाई किया गया सुरक्षित UID

  if (!orderId) {
    return res.status(400).json({ error: "Missing orderId." });
  }

  try {
    const statusPayload = {
      api_key: process.env.TRANZ_UPI_API_KEY,
      order_id: orderId
    };

    const targetUrl = `${process.env.TRANZ_UPI_BASE_URL}/check-status`;

    console.log(`Verifying payment status for Order ID: ${orderId}`);

    // TranzUPI से पेमेंट स्टेटस की जांच करें
    const gatewayResponse = await axios.post(targetUrl, statusPayload, {
      headers: { 'Content-Type': 'application/json' }
    });

    const result = gatewayResponse.data;
    
    // स्टेटस चेक करें (सफल होने पर Status 'SUCCESS' या 'PAID' हो सकता है)
    const paymentStatus = result.status || (result.data ? result.data.status : "PENDING");
    const verifiedAmount = parseFloat(result.amount || (result.data ? result.data.amount : 0));

    if (paymentStatus === "SUCCESS" || paymentStatus === "PAID") {
      
      const userRef = db.collection('users').doc(userId);

      // Firestore transaction के जरिए सुरक्षा सुनिश्चित करें ताकि एक पेमेंट दो बार क्रेडिट न हो सके
      const transactionSuccess = await db.runTransaction(async (transaction) => {
        const userDoc = await transaction.get(userRef);
        if (!userDoc.exists) {
          throw new Error("User document does not exist in Firestore.");
        }

        const userData = userDoc.data();
        const currentTransactions = userData.transactions || [];

        // चेक करें कि यह Order ID पहले से तो प्रोसेस नहीं हो चुका है
        const isDuplicate = currentTransactions.some(txn => txn.orderId === orderId);
        if (isDuplicate) {
          return { alreadyProcessed: true };
        }

        // वॉलेट बैलेंस और ट्रांजैक्शन हिस्ट्री अपडेट करें
        const depositAmount = verifiedAmount > 0 ? verifiedAmount : 10; // सुरक्षा बैकअप राशि
        transaction.update(userRef, {
          balance: admin.firestore.FieldValue.increment(depositAmount),
          transactions: admin.firestore.FieldValue.arrayUnion({
            type: 'credit',
            amount: depositAmount,
            msg: `Deposit via UPI (Ref: ${orderId})`,
            orderId: orderId,
            date: Date.now()
          })
        });

        return { alreadyProcessed: false };
      });

      console.log(`Order ${orderId} verified and wallet updated successfully.`);
      return res.json({ status: 'PAID' });
    } else {
      console.log(`Order ${orderId} is still pending or failed. Status: ${paymentStatus}`);
      return res.json({ status: 'PENDING' });
    }

  } catch (error) {
    console.error("Verify Order Error:", error.message);
    return res.status(500).json({ error: "Internal Server Error during verification." });
  }
});

// डिफ़ॉल्ट हेल्थ चेक रूट
app.get('/', (req, res) => {
  res.send('Purnima E-Sports Payment Backend is Active!');
});

// सर्वर पोर्ट इनिशियलाइज़ करें
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
