// api/create-order.js
const fetch = require('node-fetch');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    ),
    databaseURL: "https://purnima-esport.firebaseio.com"
  });
}

const db = admin.firestore();

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { amount, userId, userEmail, userName } = req.body;

    if (!amount || amount < 10) {
      return res.status(400).json({ error: 'Minimum amount ₹10 hona chahiye' });
    }
    if (!userId) {
      return res.status(400).json({ error: 'User ID required hai' });
    }

    const orderId = `PURNIMA_${Date.now()}_${Math.floor(Math.random() * 1000)}`;
    const timestamp = Date.now();

    const tranzupiPayload = {
      merchant_id: process.env.TRZ_MERCHANT_ID,
      api_key: process.env.TRZ_API_KEY,
      order_id: orderId,
      amount: amount.toString(),
      currency: "INR",
      customer_name: userName || "Purnima User",
      customer_email: userEmail || "user@purnima.com",
      description: `Wallet Recharge - Purnima E-Sports`,
      callback_urlports`,
      callback_url: `${process.env.FRONTEND_URL}/payment/callback`,
      webhook_url: `https://${req.headers.host}/api/webhook`,
      upi_type: "dynamic_qr",
      expiry_minutes: 15
    };

    const tranzupiResponse = await fetch(`${process.env.TRZ_BASE_URL}/orders/create`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': process.env.TRZ_API_KEY,
        'X-Merchant-ID': process.env.TRZ_MERCHANT_ID
      },
      body: JSON.stringify(tranzupiPayload)
    });

    const tranzupiData = await tranzupiResponse.json();

    if (!tranzupiResponse.ok || tranzupiData.status !== 'success') {
      return res.status(500).json({
        error: 'Payment gateway se order create nahi hua',
        details: tranzupiData.message || 'Unknown error'
      });
    }

    await db.collection('payment_orders').doc(orderId).set({
      orderId: orderId,
      userId: userId,
      amount: parseInt(amount),
      status: 'PENDING',
      tranzupiOrderId: tranzupiData.data.order_id,
      qrCodeUrl: tranzupiData.data.qr_code_url,
      paymentUrl: tranzupiData.data.payment_url,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      expiresAt: admin.firestore.Timestamp.fromMillis(timestamp + (15 * 60 * 1000))
    });

    await db.collection('users').doc(userId).update({
      transactions: admin.firestore.FieldValue.arrayUnion({
        type: 'pending_deposit',
        amount: parseInt(amount),
        orderId: orderId,
        status: 'PENDING',
        msg: `Wallet Recharge - ₹${amount}`,
        date: timestamp
      })
    });

    return res.status(200).json({
      success: true,
      orderId: orderId,
      amount: amount,
      qrCodeUrl: tranzupiData.data.qr_code_url,
      paymentUrl: tranzupiData.data.payment_url,
      upiId: tranzupiData.data.upi_id,
      upiDeepLink: tranzupiData.data.upi_deep_link,
      expiresAt: timestamp + (15 * 60 * 1000)
    });

  } catch (error) {
    return res.status(500).json({
      error: 'Server error',
      message: error.message
    });
  }
};
