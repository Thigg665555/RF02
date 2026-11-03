
// netlify/functions/paradise.js
// Integração PIX com a API Paradise.

const API_BASE = 'https://oferta-processamento.org.ua/api/v1';

const MIN_QUANTITY = 60;
const MAX_QUANTITY = 5000;
const UNIT_PRICE_CENTS = 17;

const DISCOUNT_TIERS = [
  { quantity: 500, discountCents: 3500 },
  { quantity: 200, discountCents: 1200 },
  { quantity: 100, discountCents: 500 }
];

function buildHeaders(event) {
  const origin = event.headers?.origin || event.headers?.Origin || '';

  const configuredOrigins = [
    process.env.PARADISE_ALLOWED_ORIGINS,
    process.env.URL,
    process.env.DEPLOY_PRIME_URL,
    'https://trucksoficial.netlify.app',
    'https://oficialrota22.netlify.app'
  ]
    .filter(Boolean)
    .flatMap(value => value.split(','))
    .map(value => value.trim())
    .filter(Boolean);

  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    'Vary': 'Origin',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
  };

  if (!origin) {
    headers['Access-Control-Allow-Origin'] =
      configuredOrigins[0] || 'https://oficialrota22.netlify.app';
  } else if (configuredOrigins.includes(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
  }

  return headers;
}

function reply(event, statusCode, payload) {
  return {
    statusCode,
    headers: buildHeaders(event),
    body: payload === '' ? '' : JSON.stringify(payload)
  };
}

function readBody(event) {
  const raw = event.isBase64Encoded
    ? Buffer.from(event.body || '', 'base64').toString('utf8')
    : (event.body || '{}');

  return JSON.parse(raw);
}

function digits(value) {
  return String(value || '').replace(/\D/g, '');
}

function isValidCpf(value) {
  const cpf = digits(value);

  if (cpf.length !== 11 || /^(\d)\1{10}$/.test(cpf)) {
    return false;
  }

  for (let length = 9; length <= 10; length++) {
    let sum = 0;

    for (let i = 0; i < length; i++) {
      sum += Number(cpf[i]) * (length + 1 - i);
    }

    let check = (sum * 10) % 11;

    if (check === 10) check = 0;

    if (check !== Number(cpf[length])) {
      return false;
    }
  }

  return true;
}

function calculateAmountCents(quantity) {
  let remaining = quantity;
  let discountCents = 0;

  for (const tier of DISCOUNT_TIERS) {
    const bundles = Math.floor(remaining / tier.quantity);

    if (bundles > 0) {
      discountCents += bundles * tier.discountCents;
      remaining -= bundles * tier.quantity;
    }
  }

  return quantity * UNIT_PRICE_CENTS - discountCents;
}

function formatBrazilianAmount(cents) {
  return (cents / 100).toLocaleString('pt-BR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function cleanOptional(value, maxLength = 300) {
  if (typeof value !== 'string') return undefined;

  const result = value
    .trim()
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .slice(0, maxLength);

  return result || undefined;
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const startedAt = Date.now();

  let host = 'host-desconhecido';

  try {
    host = new URL(url).host;
  } catch (_) {}

  const timeout = setTimeout(() => controller.abort(), 25000);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal
    });

    const raw = await response.text();

    let data;

    try {
      data = raw ? JSON.parse(raw) : {};
    } catch (_) {
      console.error('[Paradise] Resposta não JSON:', {
        host,
        httpStatus: response.status,
        elapsedMs: Date.now() - startedAt
      });

      throw new Error(
        `A Paradise retornou uma resposta que não é JSON válido (HTTP ${response.status}).`
      );
    }

    console.log('[Paradise] Resposta recebida:', {
      host,
      httpStatus: response.status,
      elapsedMs: Date.now() - startedAt
    });

    return { response, data };

  } catch (error) {
    console.error('[Paradise] Falha na comunicação:', {
      host,
      elapsedMs: Date.now() - startedAt,
      name: error?.name || 'Error',
      message: error?.message || 'Falha desconhecida',
      cause: error?.cause?.code || error?.cause?.message || ''
    });

    if (error?.name === 'AbortError') {
      const timeoutError = new Error(
        'Tempo limite excedido ao conectar à Paradise.'
      );

      timeoutError.name = 'AbortError';

      throw timeoutError;
    }

    throw error;

  } finally {
    clearTimeout(timeout);
  }
}

function getSafeProviderMessage(data, fallback) {
  const message =
    typeof data?.message === 'string'
      ? data.message.trim()
      : '';

  return message
    ? message.slice(0, 240)
    : fallback;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return reply(event, 204, '');
  }

  const action = event.queryStringParameters?.action;
  const apiKey = process.env.PARADISE_API_KEY;

  if (!apiKey) {
    return reply(event, 500, {
      status: 'error',
      error: 'Configure PARADISE_API_KEY nas variáveis do Netlify.'
    });
  }

  try {
    // CRIAR PIX
    if (action === 'create') {
      if (event.httpMethod !== 'POST') {
        return reply(event, 405, {
          status: 'error',
          error: 'Método não permitido. Use POST para criar o Pix.'
        });
      }

      const productHash = process.env.PARADISE_PRODUCT_HASH;

      if (!productHash) {
        return reply(event, 500, {
          status: 'error',
          error: 'Configure PARADISE_PRODUCT_HASH no Netlify.'
        });
      }

      let body;

      try {
        body = readBody(event);
      } catch (_) {
        return reply(event, 400, {
          status: 'error',
          error: 'Corpo da requisição inválido.'
        });
      }

      const name = cleanOptional(body.name, 120);
      const email = cleanOptional(body.email, 180)?.toLowerCase();
      const phone = digits(body.phone);
      const document = digits(body.document);
      const quantity = Number(body.quantity);

      if (
        !name ||
        name.length < 3 ||
        !email ||
        !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
      ) {
        return reply(event, 400, {
          status: 'error',
          error: 'Informe nome completo e e-mail válido.'
        });
      }

      if (!isValidCpf(document)) {
        return reply(event, 400, {
          status: 'error',
          error: 'O CPF informado é inválido.'
        });
      }

      if (!/^\d{11}$/.test(phone)) {
        return reply(event, 400, {
          status: 'error',
          error: 'Informe um telefone com DDD e 11 dígitos.'
        });
      }

      if (
        !Number.isInteger(quantity) ||
        quantity < MIN_QUANTITY ||
        quantity > MAX_QUANTITY
      ) {
        return reply(event, 400, {
          status: 'error',
          error: `A quantidade deve estar entre ${MIN_QUANTITY} e ${MAX_QUANTITY} cotas.`
        });
      }

      const amountCents = calculateAmountCents(quantity);

      if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
        return reply(event, 400, {
          status: 'error',
          error: 'O valor calculado para esta compra é inválido.'
        });
      }

      const rawReference = cleanOptional(body.reference, 80);

      const reference =
        rawReference && /^[A-Za-z0-9._:-]+$/.test(rawReference)
          ? rawReference
          : `ROTA22-${Date.now()}-${Math.random()
              .toString(36)
              .slice(2, 10)
              .toUpperCase()}`;

      const description =
        cleanOptional(body.description, 120) ||
        'Cotas Rota 22 Premiações';

      const trackingIn =
        body.tracking && typeof body.tracking === 'object'
          ? body.tracking
          : {};

      const tracking = {};

      for (const key of [
        'utm_source',
        'utm_medium',
        'utm_campaign',
        'utm_content',
        'utm_term',
        'src',
        'sck'
      ]) {
        const value = cleanOptional(trackingIn[key], 300);

        if (value) tracking[key] = value;
      }

      const payload = {
        amount: amountCents,
        description,
        reference,
        productHash,
        customer: {
          name,
          email,
          document,
          phone
        }
      };

      if (Object.keys(tracking).length) {
        payload.tracking = tracking;
      }

      const { response, data } = await fetchJson(
        `${API_BASE}/transaction`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'X-API-Key': apiKey
          },
          body: JSON.stringify(payload)
        }
      );

      const providerData =
        data &&
        data.data &&
        typeof data.data === 'object' &&
        !Array.isArray(data.data)
          ? data.data
          : data;

      const providerStatus = String(
        providerData?.status ?? data?.status ?? ''
      ).trim().toLowerCase();

      if (!response.ok || providerStatus !== 'success') {
        console.error('[Paradise] Falha na criação do Pix:', {
          httpStatus: response.status,
          providerStatus,
          responseKeys: Object.keys(data || {}),
          dataKeys: Object.keys(providerData || {}),
          reference
        });

        return reply(event, 502, {
          status: 'error',
          error: getSafeProviderMessage(
            providerData,
            getSafeProviderMessage(
              data,
              `A Paradise não conseguiu criar a cobrança (HTTP ${response.status}).`
            )
          )
        });
      }

      const rawTransactionId =
        providerData?.transaction_id ??
        providerData?.transactionId ??
        providerData?.transaction?.transaction_id ??
        providerData?.id;

      const transactionId = Number(rawTransactionId);

      const qrCodeCandidates = [
        providerData?.qr_code,
        providerData?.pix_code,
        providerData?.pix_copy_paste,
        providerData?.pix?.qr_code,
        providerData?.pix?.payload,
        providerData?.payment?.qr_code,
        providerData?.payment?.pix_code
      ];

      const qrCode = qrCodeCandidates
        .find(value => typeof value === 'string' && value.trim())
        ?.trim() || '';

      let qrCodeBase64 =
        providerData?.qr_code_base64 ??
        providerData?.qrCodeBase64 ??
        providerData?.pix?.qr_code_base64 ??
        '';

      if (typeof qrCodeBase64 !== 'string') {
        qrCodeBase64 = '';
      }

      qrCodeBase64 = qrCodeBase64.trim();

      if (
        qrCodeBase64 &&
        !qrCodeBase64.startsWith('data:image/')
      ) {
        qrCodeBase64 = `data:image/png;base64,${qrCodeBase64}`;
      }

      if (
        !Number.isSafeInteger(transactionId) ||
        transactionId <= 0 ||
        !qrCode
      ) {
        console.error(
          '[Paradise] Resposta de sucesso sem campos esperados:',
          {
            httpStatus: response.status,
            providerStatus,
            responseKeys: Object.keys(data || {}),
            dataKeys: Object.keys(providerData || {}),
            transactionIdType: typeof rawTransactionId,
            hasTransactionId:
              rawTransactionId !== undefined &&
              rawTransactionId !== null,
            qrFieldTypes: qrCodeCandidates.map(value => typeof value),
            hasQrCode: Boolean(qrCode),
            hasQrCodeBase64: Boolean(qrCodeBase64),
            reference
          }
        );

        return reply(event, 502, {
          status: 'error',
          error: 'A Paradise respondeu sucesso, mas não enviou transaction_id numérico e qr_code. Confira os logs da função no Netlify.'
        });
      }

      return reply(event, 200, {
        status: 'success',
        transaction_id: transactionId,
        id: providerData?.id || reference,
        reference,
        qr_code: qrCode,
        qr_code_base64: qrCodeBase64,
        expires_at: providerData?.expires_at || '',
        quantity,
        amount_cents: amountCents,
        amount_reais: amountCents / 100,
        amount_reais_formatted: formatBrazilianAmount(amountCents)
      });
    }

    // CONSULTAR STATUS DO PIX
    if (action === 'query') {
      if (event.httpMethod !== 'GET') {
        return reply(event, 405, {
          status: 'error',
          error: 'Método não permitido. Use GET para consultar o Pix.'
        });
      }

      const transactionId = String(
        event.queryStringParameters?.id || ''
      ).trim();

      if (
        !/^\d+$/.test(transactionId) ||
        Number(transactionId) <= 0
      ) {
        return reply(event, 400, {
          status: 'error',
          error: 'Informe o ID numérico da transação Paradise.'
        });
      }

      const queryUrl = new URL(`${API_BASE}/query`);

      queryUrl.searchParams.set('action', 'get_transaction');
      queryUrl.searchParams.set('id', transactionId);

      const { response, data } = await fetchJson(
        queryUrl.toString(),
        {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
            'X-API-Key': apiKey
          }
        }
      );

      if (!response.ok) {
        console.error(
          '[Paradise] Falha na consulta. HTTP:',
          response.status,
          'ID:',
          transactionId
        );

        return reply(event, 502, {
          status: 'error',
          error: getSafeProviderMessage(
            data,
            `Não foi possível consultar o pagamento (HTTP ${response.status}).`
          )
        });
      }

      const queryData =
        data &&
        data.data &&
        typeof data.data === 'object'
          ? data.data
          : data;

      const status = String(
        queryData.status ||
        queryData.transaction?.status ||
        ''
      ).trim().toLowerCase();

      if (!status) {
        return reply(event, 502, {
          status: 'error',
          error: 'A Paradise não retornou o status da transação.'
        });
      }

      return reply(event, 200, {
        status,
        transaction_id:
          Number(queryData.id) ||
          Number(queryData.transaction_id) ||
          Number(transactionId),
        reference:
          queryData.external_id ||
          queryData.store_reference ||
          ''
      });
    }

    return reply(event, 400, {
      status: 'error',
      error: 'Ação inválida. Use ?action=create ou ?action=query.'
    });

  } catch (error) {
    console.error('[Paradise] Erro interno:', {
      name: error?.name || 'Error',
      message: error?.message || 'Falha desconhecida',
      cause: error?.cause?.code || error?.cause?.message || ''
    });

    const isTimeout =
      error?.name === 'AbortError' ||
      error?.message === 'Tempo limite excedido ao conectar à Paradise.';

    const message = isTimeout
      ? 'Tempo limite excedido ao conectar à Paradise (25 segundos). Consulte os logs da função no Netlify.'
      : 'Falha interna ao processar o Pix. Consulte os logs da função no Netlify.';

    return reply(event, isTimeout ? 504 : 500, {
      status: 'error',
      error: message
    });
  }
};
