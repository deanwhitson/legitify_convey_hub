"""Run focused tests with dotenv, real DB and external sockets disabled."""
import os
import sys
import socket
import unittest
from pathlib import Path

root = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(root / "python_server"))
import dotenv
dotenv.load_dotenv = lambda *a, **kw: False
import asyncpg
async def deny_db(*a, **kw):
    raise AssertionError("Real database access is disabled")
asyncpg.connect = asyncpg.create_pool = deny_db
connect = socket.socket.connect
def guarded_connect(self, address):
    if not isinstance(address, tuple) or address[0] not in ("127.0.0.1", "localhost", "::1"):
        raise AssertionError("External socket access is disabled")
    return connect(self, address)
socket.socket.connect = guarded_connect
for k in list(os.environ):
    if "DATABASE_URL" in k or k.startswith(("VERIFF_", "SUMSUB_", "RUN_")):
        os.environ.pop(k)
suite = unittest.defaultTestLoader.loadTestsFromNames([
    "tests.test_veriff_verification", "tests.test_id_verification", "tests.test_verification_invitation", "tests.test_personal_passport_poc",
])
result = unittest.TextTestRunner(verbosity=1).run(suite)
sys.exit(not result.wasSuccessful())
