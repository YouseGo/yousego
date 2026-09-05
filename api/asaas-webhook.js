// /api/asaas-webhook.js
// Recebe eventos do Asaas (configurar em: Asaas → Integrações → Webhooks)
// URL a cadastrar no Asaas: https://SEU-DOMINIO.vercel.app/api/asaas-webhook
// Token de segurança: configure o mesmo valor em ASAAS_WEBHOOK_TOKEN (Vercel) e no campo
// "Token de autenticação" do webhook no painel do Asaas — o Asaas envia esse valor no
// header "asaas-access-token" em toda chamada.

import admin from 'firebase-admin';

function getAdminApp() {
  if (admin.apps.length) return admin.app();
  return admin.initializeApp({
    credential: admin.credential.cert({
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      // No painel da Vercel, cole a private key com \n literais; aqui convertemos de volta.
      privateKey: (process.env.FIREBASE_PRIVATE_KEY || '').replace(/\\n/g, '\n')
    })
  });
}

const STATUS_MAP = {
  PAYMENT_CONFIRMED: 'pago',
  PAYMENT_RECEIVED: 'pago',
  PAYMENT_OVERDUE: 'atrasado',
  PAYMENT_DELETED: 'cancelado',
  PAYMENT_REFUNDED: 'cancelado'
};

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  // ── Validação do webhook (evita que qualquer pessoa chame essa URL) ──
  const tokenEsperado = process.env.ASAAS_WEBHOOK_TOKEN;
  const tokenRecebido = req.headers['asaas-access-token'];
  if (tokenEsperado && tokenRecebido !== tokenEsperado) {
    return res.status(401).json({ error: 'Token inválido.' });
  }

  try {
    const { event, payment } = req.body || {};
    if (!event || !payment?.id) {
      return res.status(200).json({ ok: true, ignored: true });
    }

    const novoStatus = STATUS_MAP[event];
    if (!novoStatus) {
      // Evento que não tratamos (ex: PAYMENT_CREATED) — apenas confirma recebimento
      return res.status(200).json({ ok: true, ignored: true, event });
    }

    getAdminApp();
    const db = admin.firestore();

    const snap = await db.collection('invoices').where('asaasId', '==', payment.id).limit(1).get();
    if (snap.empty) {
      // Cobrança não encontrada no nosso banco — não é um erro fatal
      return res.status(200).json({ ok: true, found: false });
    }

    const faturaDoc = snap.docs[0];
    const hoje = new Date().toISOString().slice(0, 10);
    const updateData = {
      status: novoStatus,
      asaasStatus: payment.status || event,
      updatedAt: Date.now()
    };
    if (novoStatus === 'pago') {
      updateData.dataPagamento = payment.paymentDate || hoje;
    }

    const batch = db.batch();
    batch.update(db.collection('invoices').doc(faturaDoc.id), updateData);
    batch.set(db.collection('ceo_faturas').doc(faturaDoc.id), updateData, { merge: true });
    await batch.commit();

    return res.status(200).json({ ok: true, faturaId: faturaDoc.id, status: novoStatus });
  } catch (e) {
    console.error('asaas-webhook error:', e);
    // Retorna 200 mesmo em erro interno para o Asaas não ficar re-tentando indefinidamente
    // enquanto investigamos — o log do erro fica disponível nos Logs da Vercel.
    return res.status(200).json({ ok: false, error: e.message });
  }
}
