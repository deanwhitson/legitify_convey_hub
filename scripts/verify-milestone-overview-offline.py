import os
import re
import socket
import sys
import traceback
import unittest
from pathlib import Path

for name in list(os.environ):
    if re.match(r'^(DB_|PG|DATABASE_|POSTGRES_|ConveyHub_|TEST_|RUN_.*(?:DB_TESTS|MIGRATION_CHAIN_TESTS)|LEGITIFY_|ENTITIES_|DEEDLY_|JWT_|SECRET_|FILES_|DOCUMENT_|AUDIT_DATABASE|REDIS_)', name):
        os.environ.pop(name, None)
os.environ['PYTHON_DOTENV_DISABLED'] = '1'
os.environ['NODE_ENV'] = 'test'
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python_server'))
attempts = []
connect = socket.socket.connect


def guarded_connect(self, address):
    if isinstance(address, tuple) and address[0] in ('127.0.0.1', '::1') and any(frame.name == '_fallback_socketpair' for frame in traceback.extract_stack()):
        return connect(self, address)
    attempts.append('socket')
    raise AssertionError('Network connection forbidden in this offline audit')


def forbidden(*args, **kwargs):
    attempts.append('network_or_pool')
    raise AssertionError('Network/database connection forbidden in this offline audit')


socket.socket.connect = guarded_connect
socket.socket.connect_ex = forbidden
socket.create_connection = forbidden
import asyncpg
asyncpg.connect = forbidden
asyncpg.create_pool = forbidden
suite = unittest.defaultTestLoader.loadTestsFromNames([
    'tests.test_ai_tenant_security',
    'tests.test_v1_transfers',
    'tests.test_transfer_status_authority',
    'tests.test_policy',
    'tests.test_v1_matter_editing',
    'tests.test_v1_matter_documents',
])
result = unittest.TextTestRunner(verbosity=1).run(suite)
print('Blocked non-internal connection attempts:', len(attempts))
sys.exit(0 if result.wasSuccessful() and not attempts else 1)
