import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from clients.entities import EntitiesClient
from config import load_settings
from db import close_pool, get_pool
from middleware.upload_size_limit import UploadBodyLimitMiddleware
from routers import address, clauses, document_catalogue, documents, generated_documents, health, milestones, template_data_fields, transfers, users
from routers.v1 import documents as v1_documents
from routers.v1 import golden_records as v1_golden_records
from routers.v1 import id_verification as v1_id_verification
from routers.v1 import id_verification_webhooks as v1_id_verification_webhooks
from routers.v1 import properties as v1_properties
from routers.v1 import transfers as v1_transfers


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.settings = load_settings()
    try:
        await get_pool(app.state.settings)
    except Exception:
        # Dependency down at boot: stay up so /api/health/live answers and
        # /api/health/ready reports the outage. Pool creation is retried on
        # demand (per-request get_pool and the readiness probe) and recovers
        # when the database returns.
        print("Database pool unavailable at startup — serving liveness only")
    # One Legitify client for the process. httpx pools connections inside the
    # client, so a per-request client would create a new pool on every call.
    # Routes reach it through clients.dependencies.get_entities_client.
    app.state.entities_client = EntitiesClient(app.state.settings)
    try:
        yield
    finally:
        # Clear the reference before closing so an in-flight request cannot pick
        # up a half-closed client; it gets a 503 from the dependency instead.
        entities_client, app.state.entities_client = app.state.entities_client, None
        try:
            await entities_client.close()
        finally:
            # The database pool must be released even if the HTTP client fails to close.
            await close_pool()


app = FastAPI(
    title="Legitify ConveyHub API",
    version="1.0.0",
    lifespan=lifespan,
    redirect_slashes=False,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Byte-counting cap on document upload bodies: refuses chunked/undeclared
# bodies over the 25 MB limit before the multipart parser can spool them.
app.add_middleware(UploadBodyLimitMiddleware)


@app.middleware("http")
async def protect_response_boundary(request: Request, call_next):
    try:
        response = await call_next(request)
    except Exception as exc:
        return await generic_exception_handler(request, exc)
    response.headers["Cache-Control"] = "no-store"
    return response


app.include_router(health.router, prefix="/api/health")
app.include_router(transfers.router, prefix="/api/transfers")
app.include_router(v1_transfers.router, prefix="/api/v1/transfers")
app.include_router(v1_id_verification.router, prefix="/api/v1/transfers")
app.include_router(v1_id_verification_webhooks.router, prefix="/api/v1")
app.include_router(v1_golden_records.router, prefix="/api/v1/golden-records")
app.include_router(v1_documents.router, prefix="/api/v1/documents")
app.include_router(v1_properties.router, prefix="/api/v1/properties")
app.include_router(milestones.router, prefix="/api")
app.include_router(document_catalogue.router, prefix="/api/catalogue")
app.include_router(address.router, prefix="/api/address")
app.include_router(template_data_fields.router, prefix="/api/data-fields")
app.include_router(clauses.router, prefix="/api/clauses")
app.include_router(generated_documents.router, prefix="/api/generated-documents")
app.include_router(documents.router, prefix="/api/documents")
app.include_router(users.router, prefix="/api/users")


@app.get("/api")
async def root():
    return {
        "name": "Legitify ConveyHub API",
        "version": "1.0.0",
        "endpoints": [
            "GET /api/health",
            "GET /api/health/live",
            "GET /api/health/ready",
            "GET /api/transfers",
            "POST /api/transfers",
            "GET /api/transfers/:id",
            "PUT /api/transfers/:id",
            "DELETE /api/transfers/:id",
            "GET /api/transfers/:id/parties",
            "GET /api/transfers/:id/documents",
            "GET /api/transfers/:transferId/milestones",
            "PUT /api/transfers/:transferId/milestones",
            "PATCH /api/transfers/:transferId/milestones/:milestoneId",
            "GET /api/transfers/:transferId/milestones/:milestoneId/audit",
            "GET /api/transfers/:transferId/activity",
            "GET /api/catalogue",
            "POST /api/catalogue",
            "GET /api/catalogue/:id",
            "GET /api/data-fields",
            "GET /api/clauses",
            "POST /api/clauses",
            "GET /api/clauses/:id",
            "GET /api/clauses/:id/versions",
            "PUT /api/clauses/:id",
            "DELETE /api/clauses/:id",
            "GET /api/generated-documents",
            "POST /api/generated-documents",
            "GET /api/generated-documents/:id",
            "GET /api/documents",
            "GET /api/users/me",
            "PUT /api/users/me",
        ],
    }


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"success": False, "error": "Not found" if exc.status_code == 404 else exc.detail},
        headers={**(exc.headers or {}), "Cache-Control": "no-store"},
    )


@app.exception_handler(RequestValidationError)
async def validation_exception_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content={"success": False, "error": str(exc)},
    )


@app.exception_handler(Exception)
async def generic_exception_handler(request: Request, exc: Exception):
    print("API request failed")
    return JSONResponse(
        status_code=500,
        content={"success": False, "error": "Internal server error"},
        headers={"Cache-Control": "no-store"},
    )


if __name__ == "__main__":
    import uvicorn
    settings = load_settings()
    uvicorn.run("main:app", host="0.0.0.0", port=settings.port, reload=True)
