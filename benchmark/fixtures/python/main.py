from service import load_user


def bootstrap() -> dict:
    return load_user(" Benchmark ")
