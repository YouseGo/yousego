// /api/asaas-criar-cobranca.js
// Cria (ou reaproveita) um cliente no Asaas e gera uma cobrança (Pix/Boleto/Cartão).
// A ASAAS_API_KEY nunca fica exposta ao navegador — só existe aqui, no servidor (Vercel).

const ASAAS_ENV = (process.env.ASAAS_ENV || 'sandbox').toLowerCase();
const ASAAS_BASE_URL = ASAAS_ENV === 'production'
  ? 'https://api.asaas.com/v3'
  : 'https://sandbox.asaas.com/api/v3';

function onlyDigits(v) { return String(v || '').replace(/\D/g, ''); }

async function asaasFetch(path, options = {}) {
  const resp = await fetch(`${ASAAS_BASE_URL}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      'access_token': process.env.ASAAS_API_KEY,
      ...(options.headers || {})
    }
  });
  const json = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    const msg = json?.errors?.[0]?.description || json?.message || `Erro Asaas (HTTP ${resp.status})`;
    throw new Error(msg);
  }
  return json;
}

async function encontrarOuCriarCliente({ empresaId, nome, email, cpfCnpj, whatsapp }) {
  // Busca por externalReference (id da empresa no nosso sistema) para não duplicar clientes
  const busca = await asaasFetch(`/customers?externalReference=${encodeURIComponent(empresaId)}`);
  if (busca?.data?.length) return busca.data[0];

  const novo = await asaasFetch('/customers', {
    method: 'POST',
    body: JSON.stringify({
      name: nome || 'Cliente YOUSEGO',
      email: email || undefined,
      cpfCnpj: onlyDigits(cpfCnpj),
      mobilePhone: onlyDigits(whatsapp) || undefined,
      externalReference: empresaId
    })
  });
  return novo;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }
  if (!process.env.ASAAS_API_KEY) {
    return res.status(500).json({ error: 'ASAAS_API_KEY não configurada no servidor (Vercel → Environment Variables).' });
  }

  try {
    const {
      empresaId, nome, email, cpfCnpj, whatsapp,
      valor, vencimento, descricao, tipoPagamento
    } = req.body || {};

    if (!empresaId || !valor || !vencimento) {
      return res.status(400).json({ error: 'Campos obrigatórios: empresaId, valor, vencimento.' });
    }
    if (!cpfCnpj || onlyDigits(cpfCnpj).length < 11) {
      return res.status(400).json({ error: 'CPF/CNPJ da empresa é obrigatório para gerar cobrança no Asaas.' });
    }

    const cliente = await encontrarOuCriarCliente({ empresaId, nome, email, cpfCnpj, whatsapp });

    const cobranca = await asaasFetch('/payments', {
      method: 'POST',
      body: JSON.stringify({
        customer: cliente.id,
        billingType: tipoPagamento || 'UNDEFINED', // UNDEFINED | PIX | BOLETO | CREDIT_CARD
        value: Number(valor),
        dueDate: vencimento, // YYYY-MM-DD
        description: descricao || 'Fatura YOUSEGO',
        externalReference: empresaId
      })
    });

    // Se for Pix, busca o QR Code / copia-e-cola para exibir no painel do cliente
    let pixCopiaECola = null;
    if (cobranca.billingType === 'PIX' || tipoPagamento === 'PIX') {
      try {
        const pix = await asaasFetch(`/payments/${cobranca.id}/pixQrCode`);
        pixCopiaECola = pix.payload || null;
      } catch (e) { /* Pix pode não estar disponível ainda; segue sem quebrar o fluxo */ }
    }

    return res.status(200).json({
      asaasId: cobranca.id,
      status: cobranca.status,
      linkPagamento: cobranca.invoiceUrl,
      pixCopiaECola
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || 'Erro ao criar cobrança no Asaas.' });
  }
}
