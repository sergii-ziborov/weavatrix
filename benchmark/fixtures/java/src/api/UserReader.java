package api;

import model.User;

public interface UserReader {
    User load(String id);
}
