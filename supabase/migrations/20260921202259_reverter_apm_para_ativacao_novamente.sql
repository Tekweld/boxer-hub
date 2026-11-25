
-- APM foi marcada 'ativo' mas ficou com cliente_id/erp_cliente_id NULL
-- porque o Zen recusou (duplicate CNPJ) e o hub_clientes recusou o
-- insert (erp_cliente_id NOT NULL). Volta a etapa para 'ativacao' para
-- retentar com o codigo idempotente novo (que reusa Person 77128).
UPDATE comercial.hub_onboarding
SET etapa_atual = 'ativacao',
    cliente_id = NULL,
    erp_cliente_id = NULL,
    atualizado_em = now()
WHERE cnpj = '49623549000121';
