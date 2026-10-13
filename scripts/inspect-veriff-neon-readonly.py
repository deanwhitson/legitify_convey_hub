"""Inspect table metadata with existing local preview configuration only.

No secret values, DSNs or application rows are printed. No DDL is issued.
"""
import asyncio
import ssl
import json
import subprocess
import sys
from pathlib import Path
from urllib.parse import urlsplit

import asyncpg
from dotenv import dotenv_values

CONFIG_PATH = Path('D:/WORK/Legitify/Projects/LegitifyConveyHub/.vercel/.env.preview.local')


async def inspect():
    if '--deployed' in sys.argv:
        # One specifically selected application DB setting only. No bulk env
        # download; the value stays in memory and is never logged or saved.
        command = [str(Path.home() / 'AppData/Roaming/npm/vercel.cmd'), 'api',
                   '/v1/projects/prj_yWs64XL0KRHSKTK5JxsIJSs0IhYE/env/GAteLNBnBsC8i8Wl',
                   '--scope', 'team_AB913MRopZiwUOFDCbniRwfn', '--raw']
        response = subprocess.run(command, capture_output=True, text=True, timeout=30)
        if response.returncode:
            raise RuntimeError('Scoped target lookup unavailable')
        record = json.loads(response.stdout)
        if record.get('key') != 'ConveyHub_Transfers_POSTGRES_URL_NON_POOLING':
            raise RuntimeError('Wrong database configuration record')
        dsn = record.get('value')
    else:
        env = dotenv_values(CONFIG_PATH)
        dsn = env.get('ConveyHub_Transfers_POSTGRES_URL_NON_POOLING')
    if not dsn:
        raise RuntimeError('Existing preview connection is unavailable')
    url = urlsplit(dsn)
    print('Inspected target:', {'host': url.hostname, 'database': url.path.lstrip('/')})
    conn = await asyncpg.connect(dsn, ssl=ssl.create_default_context(), timeout=10)
    try:
        async with conn.transaction(readonly=True):
            rows = await conn.fetch("""SELECT table_schema,table_name FROM information_schema.tables
                WHERE table_name IN ('transfers','transfer_parties','veriff_verifications') ORDER BY 1,2""")
            print('Table metadata:', [dict(r) for r in rows])
            rows = await conn.fetch("""SELECT table_schema,column_name FROM information_schema.columns
                WHERE table_name='transfer_parties' ORDER BY table_schema,ordinal_position""")
            print('Party column metadata:', [dict(r) for r in rows])
    finally:
        await conn.close()


if __name__ == '__main__':
    try:
        asyncio.run(inspect())
    except Exception as exc:
        print('Read-only inspection failed:', type(exc).__name__, '(details suppressed)')
        raise SystemExit(1)
