-- Diagnostics CSS, JS et images d'une compilation (détail : effacé après 90 jours,
-- comme « resources »). Le résumé chiffré est ajouté à « weights ».
ALTER TABLE compilations ADD COLUMN diagnostics JSONB;
