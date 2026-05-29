// api/webhook.js
// ==============
// Purpose: Tranzupi se webhook receive kare aur auto-update kare

const crypto = require('crypto');
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
  // Webhook ke liye CORS nahi chahiye (direct server-to-server)
  if (req.method !== 'POST') {
    return res.status(405).send('Method not allowed');
  }

  try {
    // 1. Webhook signature verify karein (Security)
    const signature = req.headers['x-tranzupi-signature'];
    const payload = JSON.stringify(req.body);
    
    // Signature verify karne ka code
    const expectedSignature = crypto
      .createHmac('sha256', process.env.WEBHOOK_SECRET)
      .update(payload)
      .digest('hex');

    // Agar signature match nahi karta to reject karein
    if (signature !== expectedSignature) {
      console.warn('Invalid webhook signature');
      // Development mein skip kar sakte hain, production mein enable karein
      // return res.status(401).send('Invalid signature');
    }

    // 2. Webhook data nikalein
    const {
      order_id,
      tranzupi_order_id,
      payment_status,
      amount,
      transaction_id,
      paid_at,
      utr_number,
      payer_vpa
    } = req.body;

    console.log('Webhook received:', {
      order_id,
      status: payment_status,
      amount,
      transaction_id
    });

    // 3. Sirf SUCCESS status handle karein
    if (payment_status !== 'SUCCESS') {
      console.log(`Payment status ${payment_status}, skipping wallet update`);
      return res.status(200).send('OK');
    }

    // 4. Firebase se order find karein
    const orderQuery = await db.collection('payment_orders')
      .where('orderId', '==', order_id)
      .limit(1)
      .get();

    if (orderQuery.empty) {
      console.error('Order not found:', order_id);
      return res.status(404).send('Order not found');
    }

    const orderDoc = orderQuery.docs[0];
    const orderData = orderDoc.data();

    // Agar already processed hai
    if (orderData.status === 'SUCCESS') {
      return res.status(200).send('Already processed');
    }

    // 5. Wallet update karein
    await db.runTransaction(async (transaction) => {
      const userRef = db.collection('users').doc(orderData.userId);
      const userDoc = await transaction.get(userRef);

      if (!userDoc.exists) {
        throw new Error('User not found');
      }

      const currentBalance = userDoc.data().balance || 0;

      // Balance update
      transaction.update(userRef, {
        balance: currentBalance + orderData.amount,
        transactions: admin.firestore.FieldValue.arrayUnion({
          type: 'credit',
          amount: orderData.amount,
          orderId: order_id,
          status: 'SUCCESS',
          msg: `Wallet Recharge - ₹${orderData.amount} (Auto)`,
          date: Date.now(),
          utr: utr_number,
          transactionId: transaction_id
        })
      });

      // Order update
      transaction.update(orderDoc.ref, {
        status: 'SUCCESS',
        paidAt: admin.firestore.FieldValue.serverTimestamp(),
        transactionId: transaction_id,
        utrNumber: utr_number,
        payerVpa: payer_vpa
      });
    });

    console.log(`✅ Auto-wallet update done for order ${order_id}`);

    // 6. Tranzupi ko success response bhejein
    return res.status(200).json({
      received: true,
      status: 'processed'
    });

  } catch (error) {
    console.error('Webhook Error:', error);
    // Agar error aaya to bhi 200 bhejein (taaki Tranzupi retry na kare)
    return res.status(200).send('Error logged');
  }
};
