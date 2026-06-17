-- PostgreSQL Schema for RepairAI Visual Device Repair Assistant

-- Enable UUID extension if supported
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users Table
CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email VARCHAR(255) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    full_name VARCHAR(255) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Diagnostics Table (Visual Scans & Demos)
CREATE TABLE IF NOT EXISTS diagnostics (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    device_name VARCHAR(255) NOT NULL, -- e.g., "MacBook Pro", "iPhone 13"
    device_type VARCHAR(100) NOT NULL, -- e.g., "Laptop", "Smartphone", "Router"
    image_url VARCHAR(500),
    confidence_score DECIMAL(5,2) NOT NULL, -- e.g., 94.50
    components_detected JSONB NOT NULL, -- e.g., [{"name": "RAM", "bbox": [10, 20, 150, 200], "confidence": 0.96}]
    difficulty_score INT NOT NULL, -- 1-100
    estimated_cost DECIMAL(10,2) NOT NULL,
    success_probability DECIMAL(5,2) NOT NULL, -- e.g., 88.50
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Repairs Table (Tracks user repairs in progress)
CREATE TABLE IF NOT EXISTS repairs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    diagnosis_id UUID REFERENCES diagnostics(id) ON DELETE SET NULL,
    device_name VARCHAR(255) NOT NULL,
    device_type VARCHAR(100) NOT NULL,
    scenario_id VARCHAR(100) NOT NULL, -- e.g., "laptop_ram_upgrade"
    current_step INT DEFAULT 0,
    total_steps INT NOT NULL,
    status VARCHAR(50) DEFAULT 'in_progress', -- 'in_progress', 'completed', 'failed'
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Repair Steps Table (Specific checklist status tracking)
CREATE TABLE IF NOT EXISTS repair_steps (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    repair_id UUID REFERENCES repairs(id) ON DELETE CASCADE,
    step_index INT NOT NULL,
    step_title VARCHAR(255) NOT NULL,
    is_completed BOOLEAN DEFAULT FALSE,
    completed_at TIMESTAMP WITH TIME ZONE
);

-- Reports Table (Generated PDF Diagnostic Reports)
CREATE TABLE IF NOT EXISTS reports (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    diagnosis_id UUID REFERENCES diagnostics(id) ON DELETE CASCADE,
    pdf_url VARCHAR(500) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_diagnostics_user ON diagnostics(user_id);
CREATE INDEX IF NOT EXISTS idx_repairs_user ON repairs(user_id);
CREATE INDEX IF NOT EXISTS idx_repair_steps_repair ON repair_steps(repair_id);
