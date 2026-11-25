// Acoes administrativas sobre usuario ja existente: resetar_senha e
// alternar_ativo. As duas passam por aqui (service_role) em vez de um PATCH
// direto do cliente -- achado testando ao vivo em 25/11: o INSERT em
// hub_log_alteracoes via token do proprio usuario (RLS, so com
// `auth.uid() is not null`) estava sendo rejeitado com "new row violates
// row-level security policy" mesmo a policy parecendo trivialmente
// permissiva -- causa raiz nao identificada a tempo (pode afetar outros
// fluxos antigos que logam client-side, ex. confirmarRejeicao em
// admin.html; registrado em memoria pra investigar depois). Rotear por
// aqui com service_role contorna o problema de forma garantida E deixa o
// log de auditoria garantido no mesmo lugar que ja faz a verificacao de
// quem pode usar.
//
// Prefixo `_` -- NAO e uma serverless function propria (Vercel Hobby limita
// 12 por deploy, ja no teto). api/ativar.js despacha pra ca quando o body
// tem `acao` em vez de `tipo`/`onboarding_id`; mesma rota publica (/api/ativar).
const SB_URL = 'https://bmepxcnrsofofoswubuu.supabase.co';

module.exports = async function gerenciarUsuario(req, res) {
  const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;
  if (!SB_SERVICE) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY nao configurada' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Token de autenticacao ausente' });

  const { acao, perfil_id, novo_ativo } = req.body || {};
  if (!['resetar_senha', 'alternar_ativo'].includes(acao)) return res.status(400).json({ error: 'acao invalida' });
  if (!perfil_id) return res.status(400).json({ error: 'perfil_id obrigatorio' });
  if (acao === 'alternar_ativo' && typeof novo_ativo !== 'boolean') {
    return res.status(400).json({ error: 'novo_ativo (boolean) obrigatorio' });
  }

  const sbHeaders = (method) => ({
    'Content-Type': 'application/json',
    'apikey': SB_SERVICE,
    'Authorization': 'Bearer ' + SB_SERVICE,
    'Accept-Profile': 'comercial',
    'Content-Profile': 'comercial',
    'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal'
  });
  const authAdminH = {
    'Content-Type': 'application/json',
    'apikey': SB_SERVICE,
    'Authorization': 'Bearer ' + SB_SERVICE
  };

  try {
    // 1 — Verificar que o caller e admin
    const userRes = await fetch(SB_URL + '/auth/v1/user', {
      headers: { 'Authorization': authHeader, 'apikey': SB_SERVICE }
    });
    const caller = await userRes.json();
    if (!caller?.id) return res.status(401).json({ error: 'Token invalido' });

    const callerPerfilRes = await fetch(
      SB_URL + '/rest/v1/hub_perfis?user_id=eq.' + caller.id + '&ativo=eq.true&select=role',
      { headers: sbHeaders('GET') }
    );
    const callerPerfis = await callerPerfilRes.json();
    if (!callerPerfis?.[0] || callerPerfis[0].role !== 'admin') {
      return res.status(403).json({ error: 'Apenas admin pode gerenciar usuarios' });
    }

    // 2 — Resolver o alvo (qualquer perfil, ativo ou nao -- resetar senha ou
    // reativar alguem ja desativado e legitimo)
    const alvoRes = await fetch(
      SB_URL + '/rest/v1/hub_perfis?id=eq.' + perfil_id + '&select=user_id,nome,email,ativo',
      { headers: sbHeaders('GET') }
    );
    const alvos = await alvoRes.json();
    if (!alvos?.[0]?.user_id) return res.status(404).json({ error: 'Usuario nao encontrado' });
    const alvo = alvos[0];

    if (acao === 'alternar_ativo') {
      await fetch(SB_URL + '/rest/v1/hub_perfis?id=eq.' + perfil_id, {
        method: 'PATCH', headers: sbHeaders('PATCH'),
        body: JSON.stringify({ ativo: novo_ativo })
      });
      try {
        const logRes = await fetch(SB_URL + '/rest/v1/hub_log_alteracoes', {
          method: 'POST', headers: sbHeaders('POST'),
          body: JSON.stringify({
            usuario_id: caller.id, usuario_email: caller.email,
            tabela_ref: 'hub_perfis', registro_id: perfil_id,
            campo: 'ativo', valor_anterior: String(alvo.ativo), valor_novo: String(novo_ativo),
            acao: novo_ativo ? 'ativar_usuario' : 'desativar_usuario'
          })
        });
        if (!logRes.ok) console.error('Log de alternar_ativo falhou:', await logRes.text());
      } catch (e) {
        console.error('Log de alternar_ativo falhou:', e.message);
      }
      return res.status(200).json({ ok: true, ativo: novo_ativo });
    }

    // 3 — Nova senha temporaria via auth admin API (mesmo mecanismo ja
    // validado em api/_criar_usuario.js pra "reaproveitar usuario existente")
    const senhaTemp = generatePassword();
    const resetRes = await fetch(SB_URL + '/auth/v1/admin/users/' + alvo.user_id, {
      method: 'PUT', headers: authAdminH,
      body: JSON.stringify({ password: senhaTemp, email_confirm: true })
    });
    if (!resetRes.ok) {
      const errBody = await resetRes.json().catch(() => ({}));
      return res.status(500).json({ error: 'Erro ao redefinir senha: ' + (errBody?.msg || errBody?.message || resetRes.status) });
    }

    // 4 — Log de auditoria (nunca bloqueia a resposta -- a senha ja foi
    // trocada de verdade no passo 3, uma falha so de log nao desfaz isso)
    try {
      const logRes = await fetch(SB_URL + '/rest/v1/hub_log_alteracoes', {
        method: 'POST', headers: sbHeaders('POST'),
        body: JSON.stringify({
          usuario_id: caller.id, usuario_email: caller.email,
          tabela_ref: 'hub_perfis', registro_id: perfil_id,
          campo: 'senha', valor_anterior: null, valor_novo: null,
          acao: 'resetar_senha'
        })
      });
      if (!logRes.ok) console.error('Log de resetar_senha falhou:', await logRes.text());
    } catch (e) {
      console.error('Log de resetar_senha falhou:', e.message);
    }

    // 5 — Email avisando (mesmo provedor/padrao do welcome email)
    const RESEND_KEY = process.env.RESEND_API_KEY;
    let emailStatus = 'nao_configurado';
    if (RESEND_KEY) {
      try {
        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + RESEND_KEY },
          body: JSON.stringify({
            from: 'Boxer Hub <noreply@boxersoldas.com.br>',
            to: [alvo.email],
            subject: 'Sua senha do Boxer Hub foi redefinida',
            html: buildResetEmail(alvo.nome, alvo.email, senhaTemp)
          })
        });
        emailStatus = emailRes.ok ? 'enviado' : 'erro';
      } catch (e) {
        emailStatus = 'erro: ' + e.message;
      }
    }

    return res.status(200).json({ ok: true, email: alvo.email, senha_temp: senhaTemp, email_status: emailStatus });

  } catch (e) {
    console.error('Erro ao gerenciar usuario:', e);
    return res.status(500).json({ error: e.message });
  }
};

function buildResetEmail(nome, email, senha) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#f0f4f8;font-family:Arial,sans-serif">
    <div style="max-width:560px;margin:0 auto;padding:24px">
      <div style="text-align:center;margin-bottom:20px">
        <svg width="40" height="40" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="10" width="180" height="180" rx="30" fill="#e30613"/><line x1="30" y1="30" x2="82" y2="95" stroke="#fff" stroke-width="10" stroke-linecap="round"/><polygon points="100,38 108,80 145,55 118,88 158,92 120,105 148,138 108,118 100,162 92,118 52,138 80,105 42,92 82,88 55,55 92,80" fill="#fff"/></svg>
      </div>
      <div style="background:#fff;border:1px solid #d0d8e8;border-radius:12px;padding:28px;margin-bottom:16px">
        <p>Ola, <strong>${nome}</strong>! Sua senha do <strong>Boxer Hub</strong> foi redefinida por um administrador.</p>
        <table style="width:100%;border-collapse:collapse;background:#f7fafc;border:1px solid #e2e8f0;border-radius:8px;margin:16px 0">
          <tr><td style="padding:6px 12px;font-size:13px;color:#718096;border-bottom:1px solid #e2e8f0">Login</td><td style="padding:6px 12px;font-size:13px;color:#1a202c;font-weight:500;border-bottom:1px solid #e2e8f0">${email}</td></tr>
          <tr><td style="padding:6px 12px;font-size:13px;color:#718096">Nova senha temporaria</td><td style="padding:6px 12px;font-size:13px"><code style="font-size:16px;color:#e30613;background:#fee2e2;padding:2px 8px;border-radius:4px">${senha}</code></td></tr>
        </table>
        <p>Se voce nao pediu essa troca, fale com o administrador do Hub.</p>
        <div style="text-align:center;margin:24px 0"><a href="https://hub.boxersoldas.com.br" style="display:inline-block;padding:12px 28px;background:#1d327b;color:#fff;text-decoration:none;border-radius:8px;font-size:14px;font-weight:600">Acessar o Boxer Hub</a></div>
      </div>
      <div style="text-align:center;font-size:11px;color:#a0aec0;line-height:1.6">Boxer Soldas — hub.boxersoldas.com.br<br>Este email foi enviado automaticamente pelo Boxer Hub.</div>
    </div>
  </body></html>`;
}

function generatePassword() {
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const digits = '23456789';
  const all = upper + lower + digits;
  let pw = upper[Math.floor(Math.random() * upper.length)];
  pw += lower[Math.floor(Math.random() * lower.length)];
  pw += digits[Math.floor(Math.random() * digits.length)];
  for (let i = 0; i < 7; i++) pw += all[Math.floor(Math.random() * all.length)];
  return pw.split('').sort(() => Math.random() - 0.5).join('') + '!';
}
