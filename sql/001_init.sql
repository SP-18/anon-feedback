CREATE TABLE IF NOT EXISTS submissions (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  submitted_on  date NOT NULL DEFAULT current_date,
  body          text NOT NULL
);
