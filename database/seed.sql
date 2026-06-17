-- PostgreSQL Seeds for RepairAI

-- Seed a Mock User (password_hash for "password123")
INSERT INTO users (id, email, password_hash, full_name)
VALUES (
    'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
    'demo.user@repairai.io',
    '$2a$10$X8O5D5P6gW0c9FzD85gqU.727T63T0H3yT7f4g2t6J0N8yW5f8fFe', -- bcrypt for 'password123'
    'Ashar Prashant'
) ON CONFLICT (email) DO NOTHING;

-- Seed Sample Diagnostics
INSERT INTO diagnostics (id, user_id, device_name, device_type, confidence_score, components_detected, difficulty_score, estimated_cost, success_probability, created_at)
VALUES 
(
    'd1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
    'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
    'MacBook Pro 16" (M1)',
    'Laptop',
    96.42,
    '[{"name": "RAM", "bbox": [120, 150, 80, 45], "confidence": 0.98}, {"name": "SSD", "bbox": [220, 180, 100, 30], "confidence": 0.95}, {"name": "Battery", "bbox": [50, 310, 300, 110], "confidence": 0.99}]'::jsonb,
    45,
    180.00,
    92.50,
    NOW() - INTERVAL '3 days'
),
(
    'd2b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
    'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
    'Netgear Nighthawk WiFi 6',
    'Router',
    93.10,
    '[{"name": "WiFi Board", "bbox": [100, 80, 120, 140], "confidence": 0.92}, {"name": "Power Input Port", "bbox": [280, 200, 40, 40], "confidence": 0.96}]'::jsonb,
    30,
    45.00,
    85.00,
    NOW() - INTERVAL '5 days'
),
(
    'd3b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
    'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
    'iPhone 13 Pro',
    'Smartphone',
    97.80,
    '[{"name": "Battery", "bbox": [60, 120, 110, 260], "confidence": 0.98}, {"name": "Charging Port", "bbox": [140, 390, 40, 30], "confidence": 0.97}]'::jsonb,
    75,
    65.00,
    78.00,
    NOW() - INTERVAL '1 day'
)
ON CONFLICT DO NOTHING;

-- Seed Sample Repairs
INSERT INTO repairs (id, user_id, diagnosis_id, device_name, device_type, scenario_id, current_step, total_steps, status, created_at)
VALUES
(
    'r1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
    'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
    'd1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
    'MacBook Pro 16" (M1)',
    'Laptop',
    'laptop_ram_upgrade',
    4,
    4,
    'completed',
    NOW() - INTERVAL '3 days'
),
(
    'r2b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
    'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
    'd3b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d',
    'iPhone 13 Pro',
    'Smartphone',
    'broken_charging_port',
    2,
    5,
    'in_progress',
    NOW() - INTERVAL '1 day'
)
ON CONFLICT DO NOTHING;

-- Seed Repair Steps details
INSERT INTO repair_steps (repair_id, step_index, step_title, is_completed, completed_at)
VALUES
-- MacBook Steps (Completed)
('r1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d', 1, 'Remove the bottom panel screws', TRUE, NOW() - INTERVAL '3 days' + INTERVAL '10 minutes'),
('r1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d', 2, 'Disconnect the battery connector safety bracket', TRUE, NOW() - INTERVAL '3 days' + INTERVAL '20 minutes'),
('r1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d', 3, 'Locate the RAM shield and release side clips', TRUE, NOW() - INTERVAL '3 days' + INTERVAL '30 minutes'),
('r1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d', 4, 'Insert the new RAM module at 30 degrees and press down', TRUE, NOW() - INTERVAL '3 days' + INTERVAL '35 minutes'),

-- iPhone Steps (In Progress)
('r2b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d', 1, 'Heat the screen margins to soften adhesive', TRUE, NOW() - INTERVAL '1 day' + INTERVAL '15 minutes'),
('r2b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d', 2, 'Apply suction cup and insert opening pick', TRUE, NOW() - INTERVAL '1 day' + INTERVAL '30 minutes'),
('r2b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d', 3, 'Disconnect display ribbon cables', FALSE, NULL),
('r2b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d', 4, 'Unscrew charging dock shield plate', FALSE, NULL),
('r2b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d', 5, 'Replace charging port flex cable assembly', FALSE, NULL)
ON CONFLICT DO NOTHING;
