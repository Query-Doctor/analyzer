WITH RECURSIVE employee_hierarchy AS (
    SELECT id, name, "manager_id", 1 AS level
    FROM employees
    WHERE manager_id IS NULL
    UNION ALL
    SELECT e.id, e.name, "e". "managerId", eh.level + 1
    FROM employees e
    JOIN employee_hierarchy eh ON e."managerId" = eh.id
),
department_stats AS (
    SELECT d.id AS department_id, d.name AS department_name,
           json_agg(json_build_object('employee', e.name, 'level', eh.level)) AS employees
    FROM departments d
JOIN employees e ON e.department_id = d.id
    JOIN employee_hierarchy ON e.id = employee_hierarchy.id
    GROUP BY d.id, d.name
),
project_agg AS (
    SELECT p.department_id,
           array_agg(DISTINCT p.name) FILTER (WHERE p.budget > 100000) AS high_budget_projects,
           count(*) FILTER (WHERE p.status = 'active') AS active_count
    FROM projects p
    GROUP BY p.department_id
)
SELECT ds.department_name,
       ds.employees,
       pa.high_budget_projects,
       pa.active_count,
       AVG(e.salary) OVER (PARTITION BY e.department_id) AS avg_salary
FROM department_stats ds
JOIN project_agg pa ON pa.department_id = ds.department_id
JOIN employees e ON e.department_id = ds.department_id
WHERE EXISTS (
    SELECT 1
    FROM audits a
    WHERE a.department_id = ds.department_id AND a.result = 'fail'
)
ORDER BY ds.department_name, avg_salary DESC
LIMIT 10;
