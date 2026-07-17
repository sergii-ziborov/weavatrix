package base;

public abstract class BaseService {
    protected String normalize(String id) {
        return id.trim();
    }
}
