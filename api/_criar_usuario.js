// Cria acesso ao Hub para representante ou time interno (funcionario/admin).
// Cliente NAO passa por aqui -- revenda ja cadastrada no ZEN usa a aba
// Convites (hub_convites, api/convite.js), e CNPJ novo usa o onboarding
// (api/ativar.js). Aqui so cobre quem ainda nao tem erp_cliente_id nenhum:
// representante (ja sincronizado do ZEN, so falta o login) e time Boxer
// (sem vinculo com ZEN, mas precisa de `area` pra cair na fila certa do
// canal de resolucao).
//
// Prefixo `_` -- NAO e uma serverless function propria (Vercel Hobby limita
// 12 por deploy, ja no teto). api/ativar.js despacha pra ca quando o body
// tem `tipo` em vez de `onboarding_id`; mesma rota publica (/api/ativar).
const SB_URL = 'https://bmepxcnrsofofoswubuu.supabase.co';

module.exports = async function criarUsuarioInterno(req, res) {
  const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;
  if (!SB_SERVICE) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY nao configurada' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Token de autenticacao ausente' });

  const { tipo, representante_id, nome, email, telefone, role, area } = req.body || {};
  if (!tipo || !['representante', 'funcionario', 'admin'].includes(tipo)) {
    return res.status(400).json({ error: 'tipo deve ser representante, funcionario ou admin. Cliente usa o botao Convidar em Admin > Clientes, ou Onboarding se for cadastro novo.' });
  }
  // Lista espelha a CHECK constraint de hub_perfis.role -- sem isto, um
  // valor invalido so falhava la na gravacao, com erro cru de constraint em
  // vez de mensagem clara (achado em auditoria, 2026-11-04).
  const ROLES_VALIDOS = ['dealer', 'rep', 'analyst', 'manager', 'financial', 'admin'];
  if (!role || !ROLES_VALIDOS.includes(role)) {
    return res.status(400).json({ error: 'role invalido. Use: ' + ROLES_VALIDOS.join(', ') });
  }
  if (tipo === 'representante' && !representante_id) {
    return res.status(400).json({ error: 'Selecione um representante ja sincronizado do ZEN' });
  }
  if (tipo !== 'representante' && (!nome || !email)) {
    return res.status(400).json({ error: 'Nome e email obrigatorios' });
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

    const perfilRes = await fetch(
      SB_URL + '/rest/v1/hub_perfis?user_id=eq.' + caller.id + '&ativo=eq.true&select=role',
      { headers: sbHeaders('GET') }
    );
    const perfisCaller = await perfilRes.json();
    if (!perfisCaller?.[0] || perfisCaller[0].role !== 'admin') {
      return res.status(403).json({ error: 'Apenas admin pode criar usuarios' });
    }

    // 2 — Resolver dados conforme o tipo
    let nomeFinal = nome, emailFinal = email, clienteIdFinal = null, repIdFinal = null, areaFinal = area || null;

    if (tipo === 'representante') {
      const repRes = await fetch(
        SB_URL + '/rest/v1/hub_representantes?id=eq.' + representante_id + '&ativo=eq.true&select=*',
        { headers: sbHeaders('GET') }
      );
      const reps = await repRes.json();
      if (!reps?.[0]) return res.status(404).json({ error: 'Representante nao encontrado (precisa estar sincronizado do ZEN)' });
      if (reps[0].user_id) return res.status(400).json({ error: 'Este representante ja possui usuario' });
      repIdFinal = reps[0].id;
      nomeFinal = nome || reps[0].nome;
      emailFinal = email || reps[0].email;
      areaFinal = null; // representante nao usa area -- roteamento dele e por carteira (hub_carteira)
    }

    if (tipo === 'funcionario' && !areaFinal) {
      return res.status(400).json({ error: 'Area obrigatoria para funcionario (define pra onde o canal de resolucao roteia os chamados dele)' });
    }

    // 3 — Criar (ou reaproveitar) usuario Supabase Auth com senha temporaria
    const senhaTemp = generatePassword();
    let newUser = null, usuarioReaproveitado = false;

    const createUserRes = await fetch(SB_URL + '/auth/v1/admin/users', {
      method: 'POST', headers: authAdminH,
      body: JSON.stringify({
        email: emailFinal, password: senhaTemp, email_confirm: true,
        user_metadata: { nome: nomeFinal, tipo }
      })
    });
    const createBody = await createUserRes.json();

    if (createBody?.id) {
      newUser = createBody;
    } else {
      const errMsg = createBody?.msg || createBody?.message || createBody?.error_description || '';
      const jaExiste = /already been registered|already registered|already exists/i.test(errMsg);
      if (!jaExiste) {
        return res.status(500).json({ error: 'Erro ao criar usuario Auth: ' + (errMsg || JSON.stringify(createBody)) });
      }
      const listRes = await fetch(SB_URL + '/auth/v1/admin/users?per_page=200', { headers: authAdminH });
      const listData = await listRes.json();
      const existing = (listData?.users || []).find(u => (u.email || '').toLowerCase() === emailFinal.toLowerCase());
      if (!existing) {
        return res.status(500).json({ error: 'Auth recusou criacao ("' + errMsg + '") e nao achei o usuario existente por email' });
      }
      await fetch(SB_URL + '/auth/v1/admin/users/' + existing.id, {
        method: 'PUT', headers: authAdminH,
        body: JSON.stringify({ password: senhaTemp, email_confirm: true })
      });
      newUser = existing;
      usuarioReaproveitado = true;
    }

    // 4 — hub_perfis (cria ou reaproveita por user_id)
    const existingPerfilRes = await fetch(
      SB_URL + '/rest/v1/hub_perfis?user_id=eq.' + newUser.id + '&select=id,tipo',
      { headers: sbHeaders('GET') }
    );
    const existingPerfis = existingPerfilRes.ok ? await existingPerfilRes.json() : [];
    // Reaproveitar user Auth e normal (ex.: tentativa anterior falhou no meio),
    // mas nunca converter um perfil de cliente real em representante/funcionario
    // por causa de colisao de email.
    if (existingPerfis?.[0] && existingPerfis[0].tipo === 'cliente' && tipo !== 'cliente') {
      return res.status(400).json({ error: 'Este email ja pertence a uma conta de cliente existente. Use outro email.' });
    }
    const perfilBody = {
      tipo, role, nome: nomeFinal, email: emailFinal, telefone: telefone || null,
      cliente_id: clienteIdFinal, representante_id: repIdFinal, area: areaFinal, ativo: true
    };
    if (existingPerfis?.[0]) {
      await fetch(SB_URL + '/rest/v1/hub_perfis?id=eq.' + existingPerfis[0].id, {
        method: 'PATCH', headers: sbHeaders('PATCH'), body: JSON.stringify(perfilBody)
      });
    } else {
      await fetch(SB_URL + '/rest/v1/hub_perfis', {
        method: 'POST', headers: sbHeaders('POST'),
        body: JSON.stringify({ user_id: newUser.id, ...perfilBody })
      });
    }

    // 5 — Vincular hub_representantes.user_id
    if (tipo === 'representante') {
      await fetch(SB_URL + '/rest/v1/hub_representantes?id=eq.' + repIdFinal, {
        method: 'PATCH', headers: sbHeaders('PATCH'),
        body: JSON.stringify({ user_id: newUser.id })
      });
    }

    // 6 — Log de auditoria
    await fetch(SB_URL + '/rest/v1/hub_log_alteracoes', {
      method: 'POST', headers: sbHeaders('POST'),
      body: JSON.stringify({
        usuario_id: caller.id, usuario_email: caller.email,
        tabela_ref: 'hub_perfis', registro_id: newUser.id,
        campo: 'tipo', valor_anterior: null, valor_novo: tipo,
        acao: 'criar_usuario'
      })
    });

    // 7 — Email de boas-vindas com a senha temporaria (Resend direto, mesmo
    // padrao do api/ativar.js -- evita depender de chamar outra function)
    const RESEND_KEY = process.env.RESEND_API_KEY;
    let emailStatus = 'nao_configurado';
    if (RESEND_KEY) {
      try {
        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + RESEND_KEY },
          body: JSON.stringify({
            from: 'Boxer Hub <noreply@boxersoldas.com.br>',
            to: [emailFinal],
            subject: 'Seu acesso ao Boxer Hub foi criado',
            html: buildWelcomeEmail(nomeFinal, emailFinal, senhaTemp)
          })
        });
        emailStatus = emailRes.ok ? 'enviado' : 'erro';
      } catch (e) {
        emailStatus = 'erro: ' + e.message;
      }
    }

    return res.status(200).json({
      ok: true, user_id: newUser.id, email: emailFinal, senha_temp: senhaTemp,
      usuario_reaproveitado: usuarioReaproveitado, email_status: emailStatus
    });

  } catch (e) {
    console.error('Erro ao criar usuario:', e);
    return res.status(500).json({ error: e.message });
  }
};

function buildWelcomeEmail(nome, email, senha) {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#f0f4f8;font-family:Arial,sans-serif">
    <div style="max-width:560px;margin:0 auto;padding:24px">
      <div style="text-align:center;margin-bottom:20px">
        <svg width="40" height="40" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="10" width="180" height="180" rx="30" fill="#e30613"/><line x1="30" y1="30" x2="82" y2="95" stroke="#fff" stroke-width="10" stroke-linecap="round"/><polygon points="100,38 108,80 145,55 118,88 158,92 120,105 148,138 108,118 100,162 92,118 52,138 80,105 42,92 82,88 55,55 92,80" fill="#fff"/></svg>
      </div>
      <div style="background:#fff;border:1px solid #d0d8e8;border-radius:12px;padding:28px;margin-bottom:16px">
        <p>Ola, <strong>${nome}</strong>! Seu acesso ao <strong>Boxer Hub</strong> foi criado.</p>
        <table style="width:100%;border-collapse:collapse;background:#f7fafc;border:1px solid #e2e8f0;border-radius:8px;margin:16px 0">
          <tr><td style="padding:6px 12px;font-size:13px;color:#718096;border-bottom:1px solid #e2e8f0">Login</td><td style="padding:6px 12px;font-size:13px;color:#1a202c;font-weight:500;border-bottom:1px solid #e2e8f0">${email}</td></tr>
          <tr><td style="padding:6px 12px;font-size:13px;color:#718096">Senha temporaria</td><td style="padding:6px 12px;font-size:13px"><code style="font-size:16px;color:#e30613;background:#fee2e2;padding:2px 8px;border-radius:4px">${senha}</code></td></tr>
        </table>
        <p><strong>Recomendamos trocar a senha no primeiro acesso.</strong></p>
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
