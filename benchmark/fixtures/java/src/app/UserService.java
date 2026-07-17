package app;

import api.UserReader;
import base.BaseService;
import model.User;

public class UserService extends BaseService implements UserReader {
    private User cached;

    public User load(String id) {
        cached = new User(normalize(id));
        return cached;
    }
}
