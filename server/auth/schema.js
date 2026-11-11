export const AUTH_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS auth_users (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(80) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('EMPLEADO','ADMINISTRADOR') NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    auth_version INT UNSIGNED NOT NULL DEFAULT 1,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
    user_id BIGINT UNSIGNED NOT NULL,
    auth_version INT UNSIGNED NOT NULL,
    csrf_token CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    last_seen_at DATETIME(3) NOT NULL,
    FOREIGN KEY (user_id) REFERENCES auth_users(id),
    INDEX auth_expiry(expires_at)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS auth_session_access (
    user_id BIGINT UNSIGNED NOT NULL,
    session_code VARCHAR(50) NOT NULL,
    PRIMARY KEY(user_id,session_code),
    FOREIGN KEY (user_id) REFERENCES auth_users(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
  `CREATE TABLE IF NOT EXISTS auth_user_workspaces (
    user_id BIGINT UNSIGNED PRIMARY KEY,
    session_code VARCHAR(50) NOT NULL UNIQUE,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (user_id) REFERENCES auth_users(id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
];
