### Manual SQL commands to align families schema and remove family_identifier

```sql
-- 1) First, create a temporary column with the new ENUM type
ALTER TABLE families ADD COLUMN familyType_new ENUM('regular','local_visitor','traveller_visitor') DEFAULT 'regular';

-- 2) Migrate existing data intelligently
-- Convert 'visitor' families to specific types based on their members
UPDATE families f
SET familyType_new = (
  SELECT CASE
           WHEN COUNT(DISTINCT i.people_type) = 1 AND MAX(i.people_type) = 'local_visitor' THEN 'local_visitor'
           WHEN COUNT(DISTINCT i.people_type) = 1 AND MAX(i.people_type) = 'traveller_visitor' THEN 'traveller_visitor'
           WHEN COUNT(DISTINCT i.people_type) > 1
                AND SUM(CASE WHEN i.people_type IN ('local_visitor','traveller_visitor') THEN 1 ELSE 0 END) > 0
             THEN CASE WHEN SUM(CASE WHEN i.people_type = 'local_visitor' THEN 1 ELSE 0 END) >=
                            SUM(CASE WHEN i.people_type = 'traveller_visitor' THEN 1 ELSE 0 END)
                       THEN 'local_visitor' ELSE 'traveller_visitor' END
           ELSE 'regular'
         END
  FROM individuals i
  WHERE i.family_id = f.id
)
WHERE f.familyType = 'visitor';

-- 3) Set remaining families to 'regular'
UPDATE families f
SET familyType_new = 'regular'
WHERE f.familyType = 'regular' OR familyType_new IS NULL;

-- 4) Drop the old column and rename the new one
ALTER TABLE families DROP COLUMN familyType;
ALTER TABLE families CHANGE COLUMN familyType_new familyType ENUM('regular','local_visitor','traveller_visitor') DEFAULT 'regular';

-- 5) Now rename to snake_case
ALTER TABLE families CHANGE COLUMN familyType family_type ENUM('regular','local_visitor','traveller_visitor') DEFAULT 'regular';
ALTER TABLE families CHANGE COLUMN lastAttended last_attended DATE;

-- 6) Add notes column and migrate notes from family_identifier (if encoded as type:notes)
ALTER TABLE families ADD COLUMN family_notes TEXT AFTER family_name;
UPDATE families
SET family_notes = SUBSTRING_INDEX(family_identifier, ':', -1)
WHERE family_identifier LIKE '%:%'
  AND (family_notes IS NULL OR family_notes = '');

-- 7) Drop the old identifier column and its index (run drops only if they exist)
DROP INDEX idx_identifier ON families;
ALTER TABLE families DROP COLUMN family_identifier;

-- 8) Re-create helpful indexes
-- (If a drop is needed due to existing duplicates, run a DROP INDEX first for the same name.)
CREATE INDEX idx_family_type ON families (family_type);
CREATE INDEX idx_last_attended ON families (last_attended);

-- 9) Optional verification
-- SELECT family_type, COUNT(*) FROM families GROUP BY family_type;
-- SHOW COLUMNS FROM families;
```


