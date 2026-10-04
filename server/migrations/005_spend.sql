-- Admin → Users shows how much each person has paid and spent; these keep that fast.
create index if not exists payments_user on payments(user_id, status);
create index if not exists wallet_tx_kind on wallet_tx(workspace_id, kind);
