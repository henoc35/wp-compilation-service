-- CLS (décalages de mise en page) mesuré avant et après compilation, en conditions bridées.
ALTER TABLE compilations ADD COLUMN cls_reference DOUBLE PRECISION;
ALTER TABLE compilations ADD COLUMN cls_candidate DOUBLE PRECISION;
