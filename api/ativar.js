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
    let zenPassos = [];
    let _zenPersonEnviado = null;
    let _zenPersonResposta = null;
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

        // Resolver ids das categorias no Zen. Cada valor tem varias grafias
        // possiveis (E-commerce/Ecommerce, Hibrido/Hibrido/Híbrido). Tenta
        // em ordem, a primeira que bater vence.
        const candidatosCanal = onb.classificacao === 'ecommerce'
          ? ['Ecommerce', 'E-commerce', 'E-Commerce', 'ECOMMERCE']
          : onb.classificacao === 'hibrido'
          ? ['Hibrido', 'Híbrido', 'HIBRIDO', 'HÍBRIDO']
          : ['Varejo', 'VAREJO'];
        const candidatosFat = onb.aceita_faturamento_parcial
          ? ['Pedido Parcial', 'PEDIDO PARCIAL', 'Parcial']
          : ['Pedido Completo', 'PEDIDO COMPLETO', 'Completo'];

        let category1Id = null, category1Label = null;
        for (const cand of candidatosCanal) {
          category1Id = await resolveCategoryId(zenH, cand, 'category1');
          if (category1Id) { category1Label = cand; break; }
        }
        let category2Id = null, category2Label = null;
        for (const cand of candidatosFat) {
          category2Id = await resolveCategoryId(zenH, cand, 'category2');
          if (category2Id) { category2Label = cand; break; }
        }

        // Resolver city.id do endereco principal. Tenta em ordem:
        //   1. IBGE code (onboarding tem ibge_codigo, city.properties.fiscal_br_cMun no Zen)
        //   2. Titulo do nome + UF (Interplasma tem "São Paulo" title-case, com acento)
        //   3. nome upper + UF
        const endPrincipal = (onb.enderecos || [])[0] || {};
        const cepPrincipal = (endPrincipal.cep || '').replace(/\D/g, '');
        const cityTentativas = [];
        const cityQ = async (q) => {
          try {
            const rr = await fetch(ZEN_BASE + '/catalog/geo/city?q=' + encodeURIComponent(q) + '&first=0&max=1', { headers: zenH });
            const ok = rr.ok;
            const body = ok ? await rr.json() : null;
            const list = Array.isArray(body) ? body : (body?.content || []);
            cityTentativas.push({ q, http: rr.status, achou: !!list[0] });
            return list[0]?.id || null;
          } catch (e) { cityTentativas.push({ q, erro: e.message }); return null; }
        };
        const titleCase = (s) => (s || '').toLowerCase().replace(/(^|\s)\S/g, c => c.toUpperCase());
        let cityIdPrincipal = null;
        if (endPrincipal.ibge_codigo) {
          cityIdPrincipal = await cityQ("properties.fiscal_br_cMun=='" + endPrincipal.ibge_codigo + "'");
        }
        if (!cityIdPrincipal && endPrincipal.cidade && endPrincipal.uf) {
          const nomeTitle = titleCase(endPrincipal.cidade);
          cityIdPrincipal = await cityQ("name=='" + nomeTitle + "';state.code==" + endPrincipal.uf);
        }
        if (!cityIdPrincipal && endPrincipal.cidade && endPrincipal.uf) {
          cityIdPrincipal = await cityQ("name==" + endPrincipal.cidade + ";state.code==" + endPrincipal.uf);
        }
        if (!cityIdPrincipal && cepPrincipal.length === 8) {
          cityIdPrincipal = await cityQ("zipcode==" + cepPrincipal);
        }

        // Criar Person com TUDO no body -- a API REST do Zen nao suporta update
        // depois. O que nao entrar aqui vira ajuste manual na UI.
        // Zen armazena CNPJ com mascara (ex: "13.491.227/0001-29"); mandar sem
        // mascara pode ser aceito mas nao normalizado. Formata para o padrao.
        const cnpjLimpo = (onb.cnpj || '').replace(/\D/g, '');
        const cnpjFmt = cnpjLimpo.length === 14
          ? cnpjLimpo.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
          : onb.cnpj;

        const personBody = {
          type: 'CORPORATION',
          name: onb.razao_social,
          fantasyName: onb.nome_fantasia || onb.razao_social,
          nationality: { id: 1030 },
          documentType: 'BR_CNPJ',
          documentNumber: cnpjFmt,
          email: onb.contato_email || null,
          phone: onb.contato_telefone || null,
          comments: 'Cadastro via Boxer Hub — Onboarding ' + onboarding_id.substring(0, 8)
        };
        if (category1Id) personBody.category1 = { id: category1Id };
        if (category2Id) personBody.category2 = { id: category2Id };
        if (onb.inscricao_estadual && onb.inscricao_estadual !== 'ISENTO') {
          personBody.document2Type = 'BR_INSCRICAO_ESTADUAL';
          personBody.document2Number = onb.inscricao_estadual;
        }
        // Endereco principal na propria Person
        if (endPrincipal.logradouro) {
          personBody.zipcode = cepPrincipal;
          personBody.street = endPrincipal.logradouro;
          personBody.number = endPrincipal.numero || 'S/N';
          personBody.complement = endPrincipal.complemento || '';
          personBody.district = endPrincipal.bairro || '';
          if (cityIdPrincipal) personBody.city = { id: cityIdPrincipal };
        }

        const personRes = await fetch(ZEN_BASE + '/catalog/person/person', {
          method: 'POST', headers: zenH, body: JSON.stringify(personBody)
        });
        if (personRes.ok) {
          const person = await personRes.json();
          erpClienteId = person.id;
          zenStatus = 'ok';
          // Guarda body enviado + resposta imediata para o passo diagnostico
          _zenPersonEnviado = personBody;
          _zenPersonResposta = person;
        } else {
          const zenErr = await personRes.text();
          const jaExisteNoZen = /duplicate key|cat_person_docume/i.test(zenErr);
          if (!jaExisteNoZen) {
            throw new Error('Erro ao criar Person no ZEN: ' + zenErr);
          }
          // Person ja existe (tentativa anterior). Buscar por documentNumber
          // e reaproveitar o id para completar endereco/contato/credito.
          const cnpjLimpo = (onb.cnpj || '').replace(/\D/g, '');
          const lookupRes = await fetch(
            ZEN_BASE + '/catalog/person/person?q=' + encodeURIComponent('documentNumber==' + cnpjLimpo) + '&size=1',
            { headers: zenH }
          );
          if (!lookupRes.ok) {
            throw new Error('Person duplicada mas lookup falhou: ' + await lookupRes.text());
          }
          const lookupBody = await lookupRes.json();
          const existing = (lookupBody?.content || lookupBody || [])[0];
          if (!existing?.id) {
            throw new Error('Person duplicada mas nao achei por documentNumber=' + cnpjLimpo);
          }
          erpClienteId = existing.id;
          zenStatus = 'reaproveitou_person_' + erpClienteId;
        }

        // === Atualizar categorias na Person (SO se ela ja existia) ===
        // A API REST do Zen nao aceita PUT nem PATCH em /catalog/person/person/{id}
        // (405), e POST na colecao com id gera duplicate. Categorias em Person
        // ja criada precisam ser ajustadas na UI do Zen -- nao ha caminho REST.
        // Para Person NOVA criada nesta rodada, category1/category2 ja foram
        // enviadas no POST inicial e ficam gravadas.
        const passos = [];
        if (zenStatus.startsWith('reaproveitou_person_')) {
          passos.push({
            op: 'update_person_categorias',
            ok: false, http: 0,
            erro: 'Person ja existia no Zen (77128). REST do Zen nao suporta update de Person; ajustar Categoria 1 e Categoria 2 manualmente na UI.'
          });
        } else {
          passos.push({
            op: 'update_person_categorias',
            ok: true, http: 201,
            erro: null,
            nota: 'gravadas no POST de criacao'
          });
        }

        // === Enderecos adicionais (o principal ja foi no POST Person) ===
        // Se onboarding tiver mais de um endereco, o 2o+ vira personAddress
        // auxiliar (tipo "entrega"). Hoje o formulario so tem 1, entao skip.
        for (const endExtra of (onb.enderecos || []).slice(1)) {
          if (!endExtra?.logradouro) continue;
          const addrBody = {
            person: { id: erpClienteId },
            description: endExtra.descricao || 'Entrega',
            zipcode: (endExtra.cep || '').replace(/\D/g, ''),
            street: endExtra.logradouro,
            number: endExtra.numero || 'S/N',
            complement: endExtra.complemento || '',
            district: endExtra.bairro || ''
          };
          const addrRes = await fetch(ZEN_BASE + '/catalog/person/personAddress', {
            method: 'POST', headers: zenH, body: JSON.stringify(addrBody)
          });
          passos.push({ op: 'post_endereco_extra', ok: addrRes.ok, http: addrRes.status, erro: addrRes.ok ? null : (await addrRes.text()).slice(0, 200) });
        }

        // === Contatos adicionais (email/phone principal ja foram no POST Person) ===
        // Cria personContact para cada contato do formulario. O principal
        // (contato_email/contato_telefone) ja esta em Person.email/Person.phone;
        // esses aqui sao os contatos comercial/financeiro do step 3.
        for (const c of (onb.contatos || [])) {
          if (c.email) {
            const r = await fetch(ZEN_BASE + '/catalog/person/personContact', {
              method: 'POST', headers: zenH,
              body: JSON.stringify({
                person: { id: erpClienteId },
                type: 'EMAIL',
                description: c.email
              })
            });
            passos.push({ op: 'post_contato_email' + (c.tipo ? '_' + c.tipo : ''), ok: r.ok, http: r.status, erro: r.ok ? null : (await r.text()).slice(0, 200) });
          }
          if (c.telefone) {
            const r = await fetch(ZEN_BASE + '/catalog/person/personContact', {
              method: 'POST', headers: zenH,
              body: JSON.stringify({ person: { id: erpClienteId }, type: 'PHONE', description: c.telefone })
            });
            passos.push({ op: 'post_contato_phone' + (c.tipo ? '_' + c.tipo : ''), ok: r.ok, http: r.status, erro: r.ok ? null : (await r.text()).slice(0, 200) });
          }
        }

        // === Limite de credito ===
        // creditLineItem exige o campo `creditLine` (a "linha" a qual pertence).
        // Buscar a primeira linha ativa como padrao.
        if (onb.limite_aprovado) {
          let creditLineId = null;
          try {
            const clRes = await fetch(ZEN_BASE + '/financial/credit/creditLine?size=10', { headers: zenH });
            if (clRes.ok) {
              const clBody = await clRes.json();
              const list = clBody?.content || clBody || [];
              creditLineId = list[0]?.id || null;
            }
          } catch (_) {}

          if (!creditLineId) {
            passos.push({ op: 'lookup_creditLine', ok: false, http: 0, erro: 'nenhuma linha de credito ativa encontrada no Zen' });
          } else {
            const creditRes = await fetch(ZEN_BASE + '/financial/credit/creditLineItem', {
              method: 'POST', headers: zenH,
              body: JSON.stringify({
                person: { id: erpClienteId },
                creditLine: { id: creditLineId },
                value: onb.limite_aprovado
              })
            });
            passos.push({ op: 'post_credito', creditLine_id: creditLineId, ok: creditRes.ok, http: creditRes.status, erro: creditRes.ok ? null : (await creditRes.text()).slice(0, 300) });
          }
        }

        // === Diagnostico: reler Person e mostrar o que o Zen realmente gravou ===
        try {
          const relerRes = await fetch(ZEN_BASE + '/catalog/person/person/' + erpClienteId, { headers: zenH });
          if (relerRes.ok) {
            const p = await relerRes.json();
            const gravados = {
              name: p.name, fantasyName: p.fantasyName,
              documentNumber: p.documentNumber, document2Number: p.document2Number || null,
              email: p.email || null, phone: p.phone || null,
              zipcode: p.zipcode || null, street: p.street || null, number: p.number || null,
              complement: p.complement || null, district: p.district || null,
              city_id: p.city?.id || null, city_name: p.city?.name || null, uf: p.city?.state?.code || null,
              category1: p.category1 ? { id: p.category1.id, description: p.category1.description, code: p.category1.code } : null,
              category2: p.category2 ? { id: p.category2.id, description: p.category2.description, code: p.category2.code } : null
            };
            const enviados = _zenPersonEnviado || {};
            const chaves = Object.keys(enviados).filter(k => !['type','name','fantasyName','nationality','documentType','documentNumber','comments'].includes(k));
            const perdidos = chaves.filter(k => {
              const env = enviados[k];
              const got = k === 'category1' ? p.category1 : k === 'category2' ? p.category2 : k === 'city' ? p.city : p[k];
              return env && !got;
            });
            passos.push({
              op: 'reler_person_diagnostico', ok: true, http: 200,
              gravados_no_zen: gravados, campos_perdidos: perdidos,
              category_lookup: { category1: { id: category1Id, label: category1Label }, category2: { id: category2Id, label: category2Label } },
              city_lookup: { id: cityIdPrincipal, tentativas: cityTentativas }
            });
          }
        } catch (_) {}

        zenPassos = passos;

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

    // 4 — Criar (ou reutilizar) usuario Supabase Auth (auto-confirmado)
    // Idempotente: tentativas anteriores de ativacao podem ter criado o Auth
    // user e falhado depois (ex.: bug de nationality.id). Nesse caso, encontrar
    // o user existente por email, resetar a senha, e seguir.
    const senhaTemp = generatePassword();
    const emailCliente = onb.contato_email;
    const authAdminH = {
      'Content-Type': 'application/json',
      'apikey': SB_SERVICE,
      'Authorization': 'Bearer ' + SB_SERVICE
    };

    let newUser = null;
    let usuarioReaproveitado = false;

    const createUserRes = await fetch(SB_URL + '/auth/v1/admin/users', {
      method: 'POST',
      headers: authAdminH,
      body: JSON.stringify({
        email: emailCliente,
        password: senhaTemp,
        email_confirm: true,
        user_metadata: { nome: onb.contato_nome || onb.razao_social, tipo: 'cliente' }
      })
    });
    const createBody = await createUserRes.json();

    if (createBody?.id) {
      newUser = createBody;
    } else {
      const errMsg = createBody?.msg || createBody?.message || createBody?.error_description || '';
      const jaExiste = /already been registered|already registered|already exists/i.test(errMsg);
      if (!jaExiste) {
        return res.status(500).json({ error: 'Erro ao criar usuario Auth: ' + (errMsg || JSON.stringify(createBody)), zen_status: zenStatus });
      }
      // Buscar por email na lista de Auth users
      const listRes = await fetch(SB_URL + '/auth/v1/admin/users?per_page=200', { headers: authAdminH });
      const listData = await listRes.json();
      const users = listData?.users || [];
      const existing = users.find(u => (u.email || '').toLowerCase() === emailCliente.toLowerCase());
      if (!existing) {
        return res.status(500).json({ error: 'Auth recusou criacao ("' + errMsg + '") e nao achei o usuario existente por email', zen_status: zenStatus });
      }
      // Resetar senha para o admin poder repassar
      await fetch(SB_URL + '/auth/v1/admin/users/' + existing.id, {
        method: 'PUT',
        headers: authAdminH,
        body: JSON.stringify({ password: senhaTemp, email_confirm: true })
      });
      newUser = existing;
      usuarioReaproveitado = true;
    }

    // 5 — Criar (ou reutilizar) hub_clientes por CNPJ
    let clienteId = null;
    const existingClienteRes = await fetch(
      SB_URL + '/rest/v1/hub_clientes?cnpj=eq.' + encodeURIComponent(onb.cnpj) + '&select=id',
      { headers: sbHeaders('GET') }
    );
    const existingClientes = existingClienteRes.ok ? await existingClienteRes.json() : [];
    if (existingClientes?.[0]) {
      clienteId = existingClientes[0].id;
      // Atualizar dados vitais (erp_cliente_id pode ter chegado agora)
      await fetch(SB_URL + '/rest/v1/hub_clientes?id=eq.' + clienteId, {
        method: 'PATCH',
        headers: sbHeaders('PATCH'),
        body: JSON.stringify({
          status_cadastro: 'ativo',
          erp_cliente_id: erpClienteId || existingClientes[0].erp_cliente_id || null,
          ativo: true
        })
      });
    } else {
      // Sem erp_cliente_id, a tabela recusa (NOT NULL). Se o Zen falhou por
      // completo, nao deixamos o onboarding "meio ativo" -- interrompe aqui
      // e devolve o motivo real para a tela.
      if (!erpClienteId) {
        return res.status(500).json({
          error: 'Nao foi possivel obter erp_cliente_id do Zen; hub_clientes exige esse valor. Detalhe Zen: ' + zenStatus,
          zen_status: zenStatus
        });
      }
      const clienteRes = await fetch(SB_URL + '/rest/v1/hub_clientes', {
        method: 'POST',
        headers: sbHeaders('POST'),
        body: JSON.stringify({
          cnpj: onb.cnpj,
          razao_social: onb.razao_social,
          nome_fantasia: onb.nome_fantasia,
          status_cadastro: 'ativo',
          limite_credito: onb.limite_aprovado || 0,
          limite_disponivel: onb.limite_aprovado || 0,
          erp_cliente_id: String(erpClienteId),
          ativo: true
        })
      });
      if (clienteRes.ok) {
        const clientes = await clienteRes.json();
        clienteId = clientes?.[0]?.id || null;
      } else {
        const errTxt = await clienteRes.text();
        return res.status(500).json({
          error: 'Falha ao criar hub_clientes: HTTP ' + clienteRes.status + ' ' + errTxt.slice(0, 300),
          zen_status: zenStatus
        });
      }
    }

    // 6 — Criar (ou reutilizar) hub_perfis por user_id
    const existingPerfilRes = await fetch(
      SB_URL + '/rest/v1/hub_perfis?user_id=eq.' + newUser.id + '&select=id',
      { headers: sbHeaders('GET') }
    );
    const existingPerfis = existingPerfilRes.ok ? await existingPerfilRes.json() : [];
    if (existingPerfis?.[0]) {
      await fetch(SB_URL + '/rest/v1/hub_perfis?id=eq.' + existingPerfis[0].id, {
        method: 'PATCH',
        headers: sbHeaders('PATCH'),
        body: JSON.stringify({
          tipo: 'cliente',
          role: 'dealer',
          nome: onb.contato_nome || onb.razao_social,
          email: emailCliente,
          cliente_id: clienteId,
          ativo: true
        })
      });
    } else {
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
    }

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
      zen_passos: zenPassos,
      zen_person_enviado: _zenPersonEnviado,
      zen_person_resposta_imediata: _zenPersonResposta,
      email_status: emailStatus,
      usuario_reaproveitado: usuarioReaproveitado
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

// Resolve o id de uma personCategory. O Zen NAO expoe /catalog/person/personCategory
// (404 em todas as variacoes). O caminho e observar Persons que ja usam essa
// categoria e pegar o id dela dali. Verificado com o codigo do Monitor de
// Pedidos: category1/category2 vem embutidos em /catalog/person/person; nao
// existe endpoint separado.
//   - slot 'category1' = PERSON1 (canal: Varejo/Ecommerce/Hibrido)
//   - slot 'category2' = PERSON2 (faturamento: code "0"=Completo, "1"=Parcial)
async function resolveCategoryId(zenH, description, slot) {
  if (!description || !slot) return null;
  try {
    // Buscar uma Person que tem essa categoria com essa description.
    const q = slot + '.description==' + description;
    const url = 'https://api.zenerp.app.br/catalog/person/person?q=' +
                encodeURIComponent(q) + '&first=0&max=1';
    const r = await fetch(url, { headers: zenH });
    if (!r.ok) {
      console.warn('resolveCategoryId lookup ' + slot + '/' + description + ' HTTP ' + r.status);
      return null;
    }
    const body = await r.json();
    const list = Array.isArray(body) ? body : (body?.content || []);
    const first = list[0];
    if (!first) {
      console.warn('Nenhuma Person tem ' + slot + '.description==' + description);
      return null;
    }
    const catObj = slot === 'category1' ? first.category1 : first.category2;
    return catObj?.id || null;
  } catch (e) {
    console.warn('resolveCategoryId erro (' + slot + '/' + description + '): ' + e.message);
    return null;
  }
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
