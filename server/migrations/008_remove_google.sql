-- Google sign-in is gone. People who signed up with Google still log in with an email code (same email).
-- users.google_sub is left in place (nothing reads or writes it any more) so no data is lost by this migration.
delete from feature_flags where key = 'login_google';
delete from oauth_states where provider = 'google';
