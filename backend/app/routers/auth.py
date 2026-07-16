from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.schemas.common import UnifiedResponse
from app.schemas.auth import LoginRequest, LoginResponse, RegisterRequest, TokenData
from app.schemas.user import UserOut, UserUpdate
from app.deps import get_db, get_current_user
from app.services.auth import authenticate_user, create_access_token, hash_password, verify_password
from app.crud.user import get_user_by_username, create_user
from app.models.user import User

router = APIRouter(prefix="/api/auth", tags=["auth"])


@router.post("/login", response_model=UnifiedResponse[LoginResponse])
async def login(request: LoginRequest, db: AsyncSession = Depends(get_db)):
    user = await authenticate_user(db, request.username, request.password)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password",
        )
    token = create_access_token(
        data={"sub": str(user.id), "username": user.username}
    )
    return UnifiedResponse(
        code=200,
        data=LoginResponse(
            token=TokenData(access_token=token),
            user=UserOut.model_validate(user),
        ),
        msg="Login successful",
    )


@router.post("/register", response_model=UnifiedResponse[LoginResponse])
async def register(request: RegisterRequest, db: AsyncSession = Depends(get_db)):
    existing = await get_user_by_username(db, request.username)
    if existing:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username already exists")
    hashed = hash_password(request.password)
    user = await create_user(db, username=request.username, password_hash=hashed, role="user")
    token = create_access_token(data={"sub": str(user.id), "username": user.username})
    return UnifiedResponse(
        code=200,
        data=LoginResponse(token=TokenData(access_token=token), user=UserOut.model_validate(user)),
        msg="Registered",
    )


@router.put("/me", response_model=UnifiedResponse[UserOut])
async def update_me(
    body: UserUpdate,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    if body.username:
        existing = await get_user_by_username(db, body.username)
        if existing and existing.id != current_user.id:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username taken")
        current_user.username = body.username
    if body.avatar:
        current_user.avatar = body.avatar
    if body.password:
        if not body.old_password:
            raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Old password required")
        if not verify_password(body.old_password, current_user.password_hash):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Wrong old password")
        current_user.password_hash = hash_password(body.password)
    if body.theme:
        current_user.theme = body.theme
    if body.lang:
        current_user.lang = body.lang
    await db.commit()
    await db.refresh(current_user)
    return UnifiedResponse(code=200, data=UserOut.model_validate(current_user), msg="updated")


@router.get("/me", response_model=UnifiedResponse[UserOut])
async def get_me(current_user=Depends(get_current_user)):
    return UnifiedResponse(
        code=200,
        data=UserOut.model_validate(current_user),
        msg="ok",
    )
