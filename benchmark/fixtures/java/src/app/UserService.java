package app;

import api.UserReader;
import base.BaseService;
import model.User;
import model.UserStore;

public class UserService extends BaseService implements UserReader {
    private User cached;
    private UserStore store;

    public User load(String id) {
        cached = new User(normalize(id));
        store.save(cached);
        return cached;
    }
}
