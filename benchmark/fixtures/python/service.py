from utils import normalize_name


def load_user(raw_name: str) -> dict:
    return {"name": normalize_name(raw_name)}
