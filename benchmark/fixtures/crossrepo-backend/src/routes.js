export function getUser(request, response) {
  response.json({ id: request.params.id })
}

router.get('/api/users/:id', getUser)
