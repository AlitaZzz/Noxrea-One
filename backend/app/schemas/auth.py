from pydantic import BaseModel, Field

from app.schemas.user import UserOut


class LoginRequest(BaseModel):
    username: str = Field(max_length=50)
    password: str


class RegisterRequest(BaseModel):
    username: str = Field(max_length=50)
    password: str


class TokenData(BaseModel):
    access_token: str
    token_type: str = "bearer"


class LoginResponse(BaseModel):
    token: TokenData
    user: UserOut
