
-- Limpa hub_perfis, hub_clientes e Auth user da APM, e volta onboarding
-- para 'ativacao'. Assim a proxima ativacao entra pelo caminho "novo"
-- (POST Person completo) em vez do caminho "reuso" que nao consegue
-- popular categorias/main fields depois.
DELETE FROM comercial.hub_perfis WHERE user_id = 'cd0cb510-2580-4876-b372-2507a1ea1fdd';
DELETE FROM comercial.hub_clientes WHERE cnpj = '49623549000121';
DELETE FROM auth.users WHERE email = 'usuario-teste@example.invalid';

UPDATE comercial.hub_onboarding
SET etapa_atual = 'ativacao',
    cliente_id = NULL,
    user_id = NULL,
    erp_cliente_id = NULL,
    atualizado_em = now()
WHERE cnpj = '49623549000121';
