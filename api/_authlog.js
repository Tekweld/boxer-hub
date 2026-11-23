// Grava em comercial.hub_log_autenticacao (login_sucesso/login_falha/logout).
// Existe desde sempre no schema, nunca foi escrita por nenhum fluxo -- achado
// na auditoria de governanca de 2026-11-19 (zero trilha de quem logou, de
// onde, quando, nem tentativa de login falha). RLS da tabela tem zero
// policies, entao so entra via service_role (este endpoint).
//
// Despachado via api/push-pedido.js?target=authlog -- underscore de proposito,
// nao conta nos 12 do plano Hobby (mesmo padrao de _orcamento/_historico).
const HUB_URL = 'https://bmepxcnrsofofoswubuu.supabase.co';
const EVENTOS_VALIDOS = ['login_sucesso', 'login_falha', 'logout'];

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;
  if (!SB_SERVICE) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY nao configurada' });

  const body = (typeof req.body === 'string' ? (() => { try { return JSON.parse(req.body); } catch (e) { return {}; } })() : req.body) || {};
  const evento = String(body.evento || '');
  if (!EVENTOS_VALIDOS.includes(evento)) return res.status(400).json({ error: 'evento invalido' });

  const email = (body.email ? String(body.email) : '').slice(0, 300).trim().toLowerCase() || null;
  const ipAddress = String(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '').split(',')[0].trim().slice(0, 100) || null;
  const userAgent = String(req.headers['user-agent'] || '').slice(0, 300) || null;

  // Resolve usuario_id pelo token de quem chamou, quando houver (login_sucesso
  // e logout tem token; login_falha nunca tem, a autenticacao nao aconteceu).
  let usuarioId = null;
  const authHeader = req.headers.authorization;
  if (authHeader) {
    try {
      const userRes = await fetch(HUB_URL + '/auth/v1/user', { headers: { Authorization: authHeader, apikey: SB_SERVICE } });
      const caller = await userRes.json();
      usuarioId = caller?.id || null;
    } catch (_) { /* token invalido/expirado -- grava mesmo assim sem usuario_id */ }
  }

  try {
    await fetch(HUB_URL + '/rest/v1/hub_log_autenticacao', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SB_SERVICE,
        Authorization: 'Bearer ' + SB_SERVICE,
        'Content-Profile': 'comercial',
        Prefer: 'return=minimal'
      },
      body: JSON.stringify({ usuario_id: usuarioId, email, evento, ip_address: ipAddress, user_agent: userAgent })
    });
    return res.status(200).json({ ok: true });
  } catch (e) {
    // Nunca deixar isso quebrar login/logout de verdade -- so log de auditoria.
    console.error('[authlog] erro ao gravar:', e);
    return res.status(200).json({ ok: false });
  }
};
