-- Causa raiz real do bug de "INSERT falha com RLS" achado em 25/11:
-- o INSERT em si sempre esteve correto (policy de insert = auth.uid() is
-- not null). Quem bloqueava era a policy de SELECT (so admin/manager) --
-- toda escrita do cliente usa Prefer: return=representation (hub.js sb()),
-- que faz o PostgREST acrescentar RETURNING * na mesma query. Pra devolver
-- a linha, o INSERT precisa TAMBEM satisfazer a policy de SELECT; quem nao
-- e admin/manager (ex: role='analyst', ou qualquer dealer/rep que acione
-- algum log) nunca conseguia ver a propria linha de volta, e o Postgres
-- reporta isso como "violates row-level security policy" no INSERT inteiro.
-- Confirmado ao vivo: o mesmo INSERT com Prefer: return=minimal (sem
-- RETURNING) sempre funcionou -- prova direta de que a causa era a
-- SELECT, nao a INSERT.
--
-- Efeito real ja em producao (achado ao ler confirmarRejeicao em
-- admin.html): se um usuario role=analyst reprova um cadastro de
-- onboarding, o PATCH principal (hub_onboarding) ja tinha acontecido, mas
-- o log falhava e o catch interrompia o resto da funcao -- o email de
-- rejeicao pro cliente e a notificacao ao representante NUNCA rodavam,
-- e o admin via um toast de erro apesar do cadastro ja ter sido
-- rejeitado de verdade. Mesmo padrao client-side-log existe em varios
-- pontos de admin.html.
drop policy if exists hub_log_alt_select on comercial.hub_log_alteracoes;

create policy hub_log_alt_select on comercial.hub_log_alteracoes
for select using (
  comercial.hub_user_role() = any (array['admin', 'manager'])
  or usuario_id = auth.uid()
);
