const express = require('express');
const cors = require('cors');
const axios = require('axios');
const admin = require('firebase-admin');

const app = express();
app.use(cors());
app.use(express.json());

// Firebase Initialize
const serviceAccount = {
  "type": "service_account",
  "project_id": "purnima-esport",
  "private_key_id": "81f0e708780d9dda085521822ed464ced3df625b",
  "private_key": "-----BEGIN PRIVATE KEY-----\nMIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQC3LYiUYRjEVShU\nSucHRkWtVKlId/xMbHtgS1BADUjoXIvlNwSVB+Y8oVactirupx1xVLeiWXwEDg9j\nDqEWMx8ClvaCuc62UbItUCEnLaBIyxinawHo4vXXJJxsnU4OrR4EPV1g06Jxt6Q6\nrukZfrI/C3mW36LloOgZ7FbpFNQRzJCFvXdkGeYgyboyKkZLwLzTUrn8Xau63sSN\n0zKCFJvL9MU+rIeMfUw5JUte1ZLSBeCC53/HNMuDPfb+FSUfUGJplwoXv2arxPHy\nbsNuUQDCgTTV1AOr+ANAyUIQuTy8sn699/miv0F7xR5V6+SphHKs5b4Awx/2KEIG\nH/7uKvcdAgMBAAECggEABzn/JOdtvDUl2al40tMlZZCs+wRsyjEPbv2ZpWVAxpX8\nGOdiQWTl4ud0jMstB2xFX5a5heik2V4aokxN85vBse71u7OL4ap4bow2Op70r1p/\n1v8EPMVTcJDrsOdF0JNo1z76g5rl0jmt+3iyDoTukEkqG1coTIncDkXCKgDd2vPX\nYq6scBrVEqKzXSa0hhT0nuaw4BlhIPjQk6nzeUMI06acXdUZkpDI3/qT6s6vBdU7\nvPOYDSBJ/bdGAmv9KO+SJfXD306m8ZGP3b/M0sSycvGOhm+8aZDkM3lPlzXoEvL4\nbZ1plvpBx8dGRFKPs9TJvA5S0/OM32Zb9Fi2yXUwsQKBgQDw9U86DdcCOF4qaVR8\nqmVpSCwN9AbxNE5enqV4x9+cwIHZqpV/uE4o4uTtoYvM0oL4PsCa1jcAZnAgzZoQ\n4IXYYDQvhA3150VxPq2lAdpVargGxy5gr2fsBijpB3v6UlW+JicSwycHXiHxBIXr\nwxTVxYtDg7OcclMArmCciz6x1QKBgQDCnNnbCcvCWG1YDfCaX1EO8PSxM7snzVCg\n5iplGVvAWcZjF/rFhdQzJyzSPYzr6zAsneysiADNPaaBg2eqD31AK1s/EZYv15tu\nWpN3YXiUHDqBFLXjz4fx9rOmKmi/b0JT6sF8JcLTrryRzqruz7aZZ3iwbHzkTksL\n54xhCGCMKQKBgQCNUCCluGYnTC2Vi+5bqocNBqGnkTzdCsMHZN1Ah1/SC2hb4loI\n7GsSOXbvEjXt6mua8Rp99DGPj4QlCM9ZJIP6kPkqALU7SOYF8y9dPUfxnkPM3dWK\nKHS3DCnD+HqyJMVaXf++Vis2e/NF6VQtH1zBvjfdYYjdsIKTPLE2PceH/QKBgQC6\nvxiuf2/vRjtmy7md6Ok3lTC4+hMV1ocQXs0/xl2s7njYjiIteIZvr5/q/vVDTaQk\nrEZ4KOncCNTGYvoOzl46PWCJ3K5pqlOUSYZIgFfciFn7k4wW1wZ0wW8SfI+XY4Qa\nUqLoJrQVvQ9mOxL7poZqHkhJw1D1I8wP2Fl0oz1CQQKBgQDT8CLIt1ztO0urmueK\nfodP1eX9WNT0jRFPvfHF65Vb/VZpKnQlocBYnErREuX3wZngz786exLafzkb4+PA\n5lUp4+gWScxNL5C3zofLvLwwSnffGnIZW2lhk5BB2FlAj3MUunV/HeSG2PGDjIbM\n285w+5zuPQkXu1wmn2wSCmHQsw==\n-----END PRIVATE KEY-----\n",
  "client_email": "firebase-adminsdk-fbsvc@purnima-esport.iam.gserviceaccount.com",
  "client_id": "105811470004491905536",
  "auth_uri": "https://accounts.google.com/o/oauth2/auth",
  "token_uri": "https://oauth2.googleapis.com/token"
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// TranzUPI Config
// YAHAN APNA USER TOKEN DAALO (API Keys page se)
const TRANZUPI_API_SECRET = "766f3a89f4b64a5635e4f3c847c5d5fa";
const TRANZUPI_MOBILE = "9166740965";

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
    return res.status(401).json({ 
      error: 'Invalid token: ' + err.message 
    });
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
// 🔥 DEBUG TEST ROUTE - Isse pata chalega API chal raha hai ya nahi
app.get('/api/test-tranzupi', async (req, res) => {
  try {
    const formData = new URLSearchParams();
    formData.append('api_secret', TRANZUPI_API_SECRET);
    formData.append('amount', '10');
    formData.append('order_id', 'TEST_' + Date.now());
    formData.append('redirect_url', 'https://purnima-esport.web.app');
    formData.append('remark1', 'Test');
    formData.append('remark2', 'Test');

    const url = 'https://tranzupi.com/api/create-order';

    try {
      try {
        console.log('Trying URL:', url);
        const response = await axios.post(url, formData.toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 10000
        });
        console.log('SUCCESS with', url);
        return res.json({ workingUrl: url, response: response.data });
      } catch (e) {
        console.log('FAILED', url, 'Status:', e.response?.status, 'Data:', e.response?.data);
        lastError = e;
      }
    }

    return res.status(500).json({
      error: 'All TranzUPI endpoints failed',
      lastError: lastError?.message,
      lastStatus: lastError?.response?.status,
      lastData: lastError?.response?.data
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/wallet/createOrder', verifyToken, async (req, res) => {
  try {
    const { amount, orderId, userName, userEmail } = req.body;
    const uid = req.uid;

    if (!amount || amount < 10) {
      return res.status(400).json({ error: 'Minimum amount Rs.10' });
    }

    // TranzUPI Create Order
    const formData = new URLSearchParams();
    formData.append('api_secret', TRANZUPI_API_SECRET);
    formData.append('amount', amount.toFixed(2));
    formData.append('order_id', orderId);
    formData.append('redirect_url', 'https://purnima-esport.web.app');
    formData.append('remark1', 'Wallet Recharge');
    formData.append('remark2', userName || 'User');

    const urls = [
      'https://tranzupi.com/api/create-order'
    ];

    let lastError = null;
    let response = null;

    for (const url of urls) {
      try {
        console.log('CreateOrder trying:', url);
        response = await axios.post(url, formData.toString(), {
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          timeout: 15000
        });
        console.log('CreateOrder SUCCESS:', url);
        break; // Jo chal gaya, loop tod do
      } catch (e) {
        console.log('CreateOrder FAILED:', url, e.response?.status);
        lastError = e;
      }
    }

    if (!response) {
      throw lastError || new Error('All endpoints failed');
    }

    const data = response.data;
    console.log('TranzUPI Response:', JSON.stringify(data));

    if (data.status !== true) {
      return res.status(500).json({ 
        error: data.message || 'Payment creation failed',
        detail: data
      });
    }

    // Order Firestore mein save karo
    await db.collection('pending_orders').doc(orderId).set({
      uid: uid,
      amount: amount,
      orderId: orderId,
      status: 'PENDING',
      createdAt: Date.now()
    });

    // 🔥 URL nikalne ka alag-alag tarika (API version ke hisaab se)
    const paymentUrl = data.result?.payment_url || data.data?.payment_url || data.payment_url;

    return res.json({
      success: true,
      orderId: orderId,
      paymentUrl: paymentUrl,
      qrData: paymentUrl,
      upiId: 'Pay via Link'
    });

  } catch (err) {
    console.log('CreateOrder FINAL Error:', err.message);
    if (err.response) {
      console.log('Status:', err.response.status);
      console.log('Data:', JSON.stringify(err.response.data));
    }
    
    return res.status(500).json({ 
      error: err.message,
      detail: err.response ? err.response.data : null,
      hint: 'Check /api/test-tranzupi route to debug'
    });
  }
});


// VERIFY ORDER
app.post('/api/wallet/verifyOrder', verifyToken, async (req, res) => {
  try {
    const { orderId } = req.body;
    const uid = req.uid;

    const orderDoc = await db
      .collection('pending_orders')
      .doc(orderId)
      .get();
    
    if (!orderDoc.exists) {
      return res.json({ status: 'NOT_FOUND' });
    }

    const orderData = orderDoc.data();

    if (orderData.status === 'PAID') {
      return res.json({ status: 'PAID' });
    }

    // TranzUPI se status check
    const formData = new URLSearchParams();
    formData.append('api_secret', TRANZUPI_API_SECRET);
    formData.append('order_id', orderId);

       const response = await axios.post(
      'https://tranzupi.com/api/check-order-status',

   formData.toString(),
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        timeout: 10000
      }
    );

    const data = response.data;
    console.log('Check Order Response:', data);

    const payStatus = data.status || (data.result ? data.result.status : '');

    if (payStatus === 'completed' || payStatus === 'SUCCESS' || payStatus === 'PAID') {
      
      await db.collection('users').doc(uid).update({
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

      return res.json({ status: 'PAID' });
    }

    return res.json({ 
      status: 'PENDING',
      raw: data
    });

  } catch (err) {
    console.log('VerifyOrder Error:', err.message);
    return res.status(500).json({ error: err.message });
  }
});

// WEBHOOK
app.post('/api/webhook', async (req, res) => {
  try {
    const body = req.body;
    console.log('Webhook received:', body);
    
    const orderId = body.order_id || body.orderId;
    const status = body.status;

    if (status === 'completed' || status === 'PAID' || status === 'SUCCESS' || status === 'COMPLETED') {
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

          console.log('Payment processed:', orderId);
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
