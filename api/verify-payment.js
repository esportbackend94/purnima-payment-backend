// api/verify-payment.js
// =====================
// Purpose: Payment status verify kare aur wallet update kare

const fetch = require('node-fetch');
const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(
      JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    ),
    databaseURL: "https://purnima-esport-default-rtdb.firebaseio.com"
  });
}

const db = admin.firestore();

module.exports = async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { orderId } = req.body;

    if (!orderId) {
      return res.status(400).json({ error: 'Order ID required' });
    }

    // 1. Firebase se order details nikalein
    const orderDoc = await db.collection('payment_orders').doc(orderId).get();
    
    if (!orderDoc.exists) {
      return res.status(404).json({ error: 'Order nahi mila' });
    }

    const orderData = orderDoc.data();

    // Agar already processed hai
    if (orderData.status === 'SUCCESS') {
      return res.status(200).json({
        success: true,
        status: 'SUCCESS',
        message: 'Payment already successful',
        amount: orderData.amount
      });
    }

    // 2. Tranzupi se status check karein
    const verifyResponse = await fetch(`${process.env.TRZ_BASE_URL}/orders/status`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': process.env.TRZ_API_KEY,
        'X-Merchant-ID': process.env.TRZ_MERCHANT_ID
      },
      body: JSON.stringify({
        order_id: orderId,
        tranzupi_order_id: orderData.tranzupiOrderId
      })
    });

    const verifyData = await verifyResponse.json();

    // 3. Agar payment success hua
    if (verifyData.status === 'success' && verifyData.data.payment_status === 'SUCCESS') {
      
      // Wallet update karein
      await processSuccessfulPayment(orderData, orderId);
      
      return res.status(200).json({
        success: true,
        status: 'SUCCESS',
        message: 'Payment successful! Wallet updated.',
        amount: orderData.amount,
        transactionId: verifyData.data.transaction_id
      });
    }

    // Agar pending hai
    if (verifyData.data.payment_status === 'PENDING') {
      return res.status(200).json({
        success: true,
        status: 'PENDING',
        message: 'Payment abhi pending hai',
        amount: orderData.amount
      });
    }

    // Agar fail hua
    return res.status(200).json({
      success: false,
      status: 'FAILED',
      message: verifyData.data.failure_reason || 'Payment failed'
    });

  } catch (error) {
    console.error('Verify Error:', error);
    return res.status(500).json({ error: 'Verification failed', message: error.message });
  }
};

// ============== HELPER FUNCTION ==============
// Payment success hone par wallet update karega
async function processSuccessfulPayment(orderData, orderId) {
  const userId = orderData.userId;
  const amount = orderData.amount;

  // Transaction run karein (Atomic update)
  await db.runTransaction(async (transaction) => {
    const userRef = db.collection('users').doc(userId);
    const userDoc = await transaction.get(userRef);

    if (!userDoc.exists) {
      throw new Error('User not found');
    }

    const currentBalance = userDoc.data().balance || 0;
    const currentWinning = userDoc.data().winning || 0;

    // Balance update
    transaction.update(userRef, {
      balance: currentBalance + amount,
      winning: currentWinning + amount,
      transactions: admin.firestore.FieldValue.arrayUnion({
        type: 'credit',
        amount: amount,
        orderId: orderId,
        status: 'SUCCESS',
        msg: `Wallet Recharge - ₹${amount} (Tranzupi)`,
        date: Date.now()
      })
    });

    // Order status update
    const orderRef = db.collection('payment_orders').doc(orderId);
    transaction.update(orderRef, {
      status: 'SUCCESS',
      paidAt: admin.firestore.FieldValue.serverTimestamp(),
      transactionId: orderData.tranzupiOrderId
    });
  });

  console.log(`✅ Wallet updated for user ${userId}: +₹${amount}`);
}
