-- Andre pediu explicitamente (2026-11-06): parametros comerciais (ex.:
-- progressao_classe_ativa) so admin edita. A policy anterior liberava
-- manager tambem -- UI (admin.html) ja trava o campo pra nao-admin, mas
-- isso sozinho nao protege contra chamada direta a API; RLS agora reflete
-- a mesma regra de verdade.
drop policy if exists hub_politica_parametros_write on comercial.hub_politica_parametros;
create policy hub_politica_parametros_write on comercial.hub_politica_parametros
  for all using (comercial.hub_user_role() = 'admin');
