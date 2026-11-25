-- Convite de teste para criar um usuario dealer pelo fluxo real (api/convite).
-- Os dois dealers de teste que existiam estao ligados a clientes sinteticos
-- (erp_cliente_id 'TESTE-<uuid>'), que nao existem no Zen -- com eles nao da
-- para testar o push do pedido. Este aponta para um cliente real.
insert into comercial.hub_convites (cliente_id, email, token, status, criado_por, expira_em)
values (
  '60eaf53f-96ee-4872-80ce-8d5e5645765f',        -- Interplasma Corte E Soldas Eireli
  'teste.claude@boxersoldas.com.br',
  '11111111-2222-3333-4444-555555555555',
  'pendente',
  'cd0cb510-2580-4876-b372-2507a1ea1fdd',        -- Andre Coelho (admin)
  now() + interval '30 days'
)
on conflict (token) do nothing;