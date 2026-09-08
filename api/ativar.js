const SB_URL  = 'https://bmepxcnrsofofoswubuu.supabase.co';
const ZEN_BASE = 'https://api.zenerp.app.br';
const ZEN_TENANT = 'boxer';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const SB_SERVICE = process.env.SUPABASE_SERVICE_KEY;
  if (!SB_SERVICE) return res.status(500).json({ error: 'SUPABASE_SERVICE_KEY nao configurada no Vercel' });

  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'Token de autenticacao ausente' });

  const { onboarding_id } = req.body || {};
  if (!onboarding_id) return res.status(400).json({ error: 'onboarding_id obrigatorio' });

  const sbHeaders = (method) => ({
    'Content-Type': 'application/json',
    'apikey': SB_SERVICE,
    'Authorization': 'Bearer ' + SB_SERVICE,
    'Accept-Profile': 'comercial',
    'Content-Profile': 'comercial',
    'Prefer': method === 'POST' ? 'return=representation' : 'return=minimal'
  });

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
    const perfis = await perfilRes.json();
    if (!perfis?.[0] || perfis[0].role !== 'admin') {
      return res.status(403).json({ error: 'Apenas admin pode ativar clientes' });
    }

    // 2 — Buscar dados do onboarding
    const onbRes = await fetch(
      SB_URL + '/rest/v1/hub_onboarding?id=eq.' + onboarding_id + '&select=*',
      { headers: sbHeaders('GET') }
    );
    const onbs = await onbRes.json();
    if (!onbs?.[0]) return res.status(404).json({ error: 'Onboarding nao encontrado' });
    const onb = onbs[0];

    if (onb.etapa_atual !== 'ativacao') {
      return res.status(400).json({ error: 'Etapa atual e "' + onb.etapa_atual + '", precisa ser "ativacao"' });
    }

    // 3 — Criar Person no ZEN (se credenciais configuradas)
    let erpClienteId = null;
    let zenStatus = 'nao_configurado';
    const zenEmail = process.env.ZEN_EMAIL;
    const zenSenha = process.env.ZEN_SENHA;

    if (zenEmail && zenSenha) {
      try {
        const zenAuthRes = await fetch(ZEN_BASE + '/system/security/tokenOpRequest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'tenant': ZEN_TENANT },
          body: JSON.stringify({ email: zenEmail, password: zenSenha })
        });
        if (!zenAuthRes.ok) throw new Error('Falha na autenticacao ZEN: ' + zenAuthRes.status);
        const zenToken = (await zenAuthRes.text()).trim().replace(/"/g, '');

        const zenH = {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + zenToken,
          'tenant': ZEN_TENANT
        };

        // Criar Person. Bug descoberto em 2026-09-08: nationality.id de "Brasil"
        // e 1030, nao 1 -- o valor errado falhava silenciosamente e todos os 4
        // onboardings existentes ficaram sem erp_cliente_id por causa disso.
        // TODO: setar tambem `category1` (canal de venda) baseado em
        // onb.classificacao. Sem isso, o cliente criado no Zen nao entra no
        // sync-zen-clientes (que filtra por Varejo/Ecommerce/Hibrido) -- hoje
        // o admin precisa ajustar o canal manualmente no Zen apos a ativacao.
        // Fazer resolvendo `id` do canal via /catalog/person/personCategory
        // antes de POSTar a Person, para nao chutar a forma do payload.
        const personBody = {
          type: 'CORPORATION',
          name: onb.razao_social,
          fantasyName: onb.nome_fantasia || onb.razao_social,
          nationality: { id: 1030 },
          documentType: 'BR_CNPJ',
          documentNumber: onb.cnpj,
          comments: 'Cadastro via Boxer Hub — Onboarding ' + onboarding_id.substring(0, 8)
        };
        if (onb.inscricao_estadual && onb.inscricao_estadual !== 'ISENTO') {
          personBody.document2Type = 'BR_INSCRICAO_ESTADUAL';
          personBody.document2Number = onb.inscricao_estadual;
        }

        const personRes = await fetch(ZEN_BASE + '/catalog/person/person', {
          method: 'POST', headers: zenH, body: JSON.stringify(personBody)
        });
        if (!personRes.ok) {
          const zenErr = await personRes.text();
          throw new Error('Erro ao criar Person no ZEN: ' + zenErr);
        }
        const person = await personRes.json();
        erpClienteId = person.id;

        // Criar endereco
        const end = (onb.enderecos || [])[0];
        if (end?.logradouro) {
          await fetch(ZEN_BASE + '/catalog/person/personAddress', {
            method: 'POST', headers: zenH,
            body: JSON.stringify({
              person: { id: erpClienteId },
              description: 'Principal',
              zipcode: (end.cep || '').replace(/\D/g, ''),
              street: end.logradouro,
              number: end.numero || '',
              complement: end.complemento || '',
              district: end.bairro || ''
            })
          });
        }

        // Criar contatos
        for (const c of (onb.contatos || [])) {
          if (c.email) {
            await fetch(ZEN_BASE + '/catalog/person/personContact', {
              method: 'POST', headers: zenH,
              body: JSON.stringify({
                person: { id: erpClienteId },
                type: 'EMAIL',
                description: c.email
              })
            });
          }
          if (c.telefone) {
            await fetch(ZEN_BASE + '/catalog/person/personContact', {
              method: 'POST', headers: zenH,
              body: JSON.stringify({
                person: { id: erpClienteId },
                type: 'PHONE',
                description: c.telefone
              })
            });
          }
        }

        // Criar limite de credito
        if (onb.limite_aprovado) {
          const creditRes = await fetch(ZEN_BASE + '/financial/credit/creditLineItem', {
            method: 'POST', headers: zenH,
            body: JSON.stringify({
              person: { id: erpClienteId },
              value: onb.limite_aprovado
            })
          });
          if (!creditRes.ok) {
            console.warn('Aviso: falha ao criar credito no ZEN — limite sera definido manualmente');
          }
        }

        zenStatus = 'ok';
      } catch (zenErr) {
        // Antes o erro do Zen so ia parar no log e ninguem via. Agora fica no
        // proprio hub_onboarding.credito_status_detalhe (reaproveita a coluna
        // ja usada para observacao) e no zen_status devolvido, que a tela
        // deve mostrar como aviso claro.
        zenStatus = 'erro: ' + zenErr.message.slice(0, 250);
        console.error('ZEN error:', zenErr.message);
      }
    }

    // 4 — Criar usuario Supabase Auth (auto-confirmado)
    const senhaTemp = generatePassword();
    const emailCliente = onb.contato_email;

    const createUserRes = await fetch(SB_URL + '/auth/v1/admin/users', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SB_SERVICE,
        'Authorization': 'Bearer ' + SB_SERVICE
      },
      body: JSON.stringify({
        email: emailCliente,
        password: senhaTemp,
        email_confirm: true,
        user_metadata: { nome: onb.contato_nome || onb.razao_social, tipo: 'cliente' }
      })
    });
    const newUser = await createUserRes.json();
    if (!newUser?.id) {
      const errMsg = newUser?.msg || newUser?.message || JSON.stringify(newUser);
      return res.status(500).json({ error: 'Erro ao criar usuario Auth: ' + errMsg, zen_status: zenStatus });
    }

    // 5 — Criar hub_clientes
    const clienteBody = {
      cnpj: onb.cnpj,
      razao_social: onb.razao_social,
      nome_fantasia: onb.nome_fantasia,
      status_cadastro: 'ativo',
      limite_credito: onb.limite_aprovado || 0,
      limite_disponivel: onb.limite_aprovado || 0,
      erp_cliente_id: erpClienteId,
      ativo: true
    };

    const clienteRes = await fetch(SB_URL + '/rest/v1/hub_clientes', {
      method: 'POST',
      headers: sbHeaders('POST'),
      body: JSON.stringify(clienteBody)
    });
    let clienteId = null;
    if (clienteRes.ok) {
      const clientes = await clienteRes.json();
      clienteId = clientes?.[0]?.id || null;
    }

    // 6 — Criar hub_perfis
    await fetch(SB_URL + '/rest/v1/hub_perfis', {
      method: 'POST',
      headers: sbHeaders('POST'),
      body: JSON.stringify({
        user_id: newUser.id,
        tipo: 'cliente',
        role: 'dealer',
        nome: onb.contato_nome || onb.razao_social,
        email: emailCliente,
        cliente_id: clienteId,
        ativo: true
      })
    });

    // 7 — Atualizar hub_onboarding para 'ativo'
    await fetch(SB_URL + '/rest/v1/hub_onboarding?id=eq.' + onboarding_id, {
      method: 'PATCH',
      headers: sbHeaders('PATCH'),
      body: JSON.stringify({
        etapa_atual: 'ativo',
        user_id: newUser.id,
        cliente_id: clienteId,
        erp_cliente_id: erpClienteId,
        atualizado_em: new Date().toISOString()
      })
    });

    // 8 — Log de auditoria
    await fetch(SB_URL + '/rest/v1/hub_log_alteracoes', {
      method: 'POST',
      headers: sbHeaders('POST'),
      body: JSON.stringify({
        usuario_id: caller.id,
        usuario_email: caller.email,
        tabela_ref: 'hub_onboarding',
        registro_id: onboarding_id,
        campo: 'etapa_atual',
        valor_anterior: 'ativacao',
        valor_novo: 'ativo',
        acao: 'ativacao_cliente'
      })
    });

    // 9 — Email de boas-vindas ao cliente
    const RESEND_KEY = process.env.RESEND_API_KEY;
    let emailStatus = 'nao_configurado';
    if (RESEND_KEY) {
      try {
        const emailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + RESEND_KEY
          },
          body: JSON.stringify({
            from: 'Boxer Hub <noreply@boxersoldas.com.br>',
            to: [emailCliente],
            subject: 'Sua conta no Boxer Hub foi ativada!',
            html: buildActivationEmail(onb.razao_social, emailCliente, senhaTemp, onb.limite_aprovado)
          })
        });
        emailStatus = emailRes.ok ? 'enviado' : 'erro';
      } catch (emailErr) {
        emailStatus = 'erro: ' + emailErr.message;
        console.error('Erro ao enviar email de ativacao:', emailErr.message);
      }
    }

    return res.status(200).json({
      ok: true,
      razao_social: onb.razao_social,
      email: emailCliente,
      senha_temp: senhaTemp,
      limite: onb.limite_aprovado,
      erp_cliente_id: erpClienteId,
      cliente_id: clienteId,
      user_id: newUser.id,
      zen_status: zenStatus,
      email_status: emailStatus
    });

  } catch (e) {
    console.error('Erro na ativacao:', e);
    return res.status(500).json({ error: e.message });
  }
}

function buildActivationEmail(razao, email, senha, limite) {
  const fmtLimite = limite ? 'R$ ' + Number(limite).toLocaleString('pt-BR', { minimumFractionDigits: 2 }) : '—';
  return `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;padding:0;background:#f0f4f8;font-family:Arial,sans-serif">
    <div style="max-width:560px;margin:0 auto;padding:24px">
      <div style="text-align:center;margin-bottom:20px">
        <svg width="40" height="40" viewBox="0 0 200 200" xmlns="http://www.w3.org/2000/svg"><rect x="10" y="10" width="180" height="180" rx="30" fill="#e30613"/><line x1="30" y1="30" x2="82" y2="95" stroke="#fff" stroke-width="10" stroke-linecap="round"/><polygon points="100,38 108,80 145,55 118,88 158,92 120,105 148,138 108,118 100,162 92,118 52,138 80,105 42,92 82,88 55,55 92,80" fill="#fff"/></svg>
      </div>
      <div style="background:#fff;border:1px solid #d0d8e8;border-radius:12px;padding:28px;margin-bottom:16px">
        <p>Bem-vindo ao <strong>Boxer Hub</strong>! Sua conta foi ativada com sucesso.</p>
        <table style="width:100%;border-collapse:collapse;background:#f7fafc;border:1px solid #e2e8f0;border-radius:8px;margin:16px 0">
          <tr><td style="padding:6px 12px;font-size:13px;color:#718096;border-bottom:1px solid #e2e8f0">Empresa</td><td style="padding:6px 12px;font-size:13px;color:#1a202c;font-weight:500;border-bottom:1px solid #e2e8f0">${razao}</td></tr>
          <tr><td style="padding:6px 12px;font-size:13px;color:#718096;border-bottom:1px solid #e2e8f0">Login</td><td style="padding:6px 12px;font-size:13px;color:#1a202c;font-weight:500;border-bottom:1px solid #e2e8f0">${email}</td></tr>
          <tr><td style="padding:6px 12px;font-size:13px;color:#718096;border-bottom:1px solid #e2e8f0">Senha temporaria</td><td style="padding:6px 12px;font-size:13px;border-bottom:1px solid #e2e8f0"><code style="font-size:16px;color:#e30613;background:#fee2e2;padding:2px 8px;border-radius:4px">${senha}</code></td></tr>
          <tr><td style="padding:6px 12px;font-size:13px;color:#718096">Limite de credito</td><td style="padding:6px 12px;font-size:13px;color:#1a202c;font-weight:500">${fmtLimite}</td></tr>
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
