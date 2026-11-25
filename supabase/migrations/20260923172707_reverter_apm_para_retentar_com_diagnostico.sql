
-- Volta a etapa para 'ativacao' para retentar. Mantem hub_clientes e
-- hub_perfis (codigo idempotente reusa). O que precisa acontecer nesta
-- nova rodada e completar a Person 77128 no Zen: categorias, endereco,
-- contatos, limite -- todos os erros vao voltar no zen_passos.
UPDATE comercial.hub_onboarding
SET etapa_atual = 'ativacao',
    atualizado_em = now()
WHERE cnpj = '49623549000121';
