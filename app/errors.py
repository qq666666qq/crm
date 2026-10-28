from fastapi import HTTPException

def error(status, code, message):
    return HTTPException(status_code=status, detail={'code': code, 'message': message})
