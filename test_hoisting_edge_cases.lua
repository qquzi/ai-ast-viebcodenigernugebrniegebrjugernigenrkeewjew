-- Case 1: a for-loop's bound depends on an earlier local in the same block
-- (that local gets hoisted when this block is flattened)
do
	local n = 5
	local total = 0
	for i = 1, n do
		total = total + i
	end
	print("case1", total)
end

-- Case 2: nested do-block shadows a hoisted outer local
do
	local x = 1
	do
		local x = 99
		print("case2_inner", x)
	end
	print("case2_outer", x)
end

-- Case 3: a function expression parameter shadows a hoisted outer local
do
	local x = 5
	local f = function(x)
		return x * 2
	end
	print("case3", f(10), x)
end

-- Case 4: repeat/until where the until-condition reads a body local that
-- gets hoisted (Lua's until can see body locals - this is the special case
-- scope.js handles explicitly)
do
	local n = 0
	local x
	repeat
		x = n
		n = n + 1
	until x >= 3
	print("case4", x, n)
end

-- Case 5: closures capturing a hoisted loop-scoped local across iterations
do
	local fns = {}
	for i = 1, 3 do
		local captured = i * 10
		fns[i] = function() return captured end
	end
	print("case5", fns[1](), fns[2](), fns[3]())
end

-- Case 6: multiple locals declared in one statement, used across branches
do
	local a, b = 1, 2
	local c = a + b
	local d = c * a
	print("case6", a, b, c, d)
end

-- Case 7: early return depending on a hoisted local (return must always exit
-- the function immediately regardless of how the block around it was
-- restructured - the state-advance statement after it must never run)
local function classify(n)
	local doubled = n * 2
	if doubled > 10 then
		return "big", doubled
	end
	local tripled = doubled * 3
	return "small", tripled
end
print("case7a", classify(6))
print("case7b", classify(2))

-- Case 8: deeply nested blocks, each independently eligible for flattening,
-- with locals threaded through several levels
local function deepNest(seed)
	local a = seed + 1
	do
		local b = a * 2
		do
			local c = b + a
			local d = c - 1
			if d > 0 then
				local e = d * 10
				print("case8", a, b, c, d, e)
			end
		end
	end
end
deepNest(3)
